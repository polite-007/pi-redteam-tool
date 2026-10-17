/**
 * Shared DNS-over-HTTPS JSON client.
 *
 * Uses the Google/Cloudflare-style JSON API (`/resolve?name=&type=`) so one
 * helper works for both `dns_lookup` (records transport and DNSSEC status) and
 * `net_lookup` (Team Cymru IP→ASN TXT lookups) without adding dependencies.
 *
 * Free, no API key. Providers differ in reachability by network: `doh.pub`
 * and AliDNS are reachable from mainland China, Google/Cloudflare often are
 * not. Callers can pass a preset, a full URL, or the ordered `auto` list.
 */

export type DohAnswer = {
  name: string;
  /** Numeric DNS RR type (1 = A, 16 = TXT, …). */
  type: number;
  ttl: number;
  data: string;
};

export type DohResult = {
  /** DNS RCODE: 0 = NOERROR, 2 = SERVFAIL, 3 = NXDOMAIN, 5 = REFUSED. */
  status: number;
  /** True when the resolver validated the response with DNSSEC (AD flag). */
  authenticated: boolean;
  answers: DohAnswer[];
  comment?: string;
  /** Endpoint that produced this response when a fallback list was used. */
  endpoint: string;
};

export const DOH_PROVIDERS: Record<string, string> = {
  google: "https://dns.google/resolve",
  cloudflare: "https://cloudflare-dns.com/dns-query",
  quad9: "https://dns.quad9.net/dns-query",
  alidns: "https://dns.alidns.com/resolve",
  "doh.pub": "https://doh.pub/dns-query",
};

/**
 * Order used when no endpoint is configured. Public resolvers that answer
 * from both mainland China and most other networks first; global defaults
 * last, so a blocked provider costs one timeout at most.
 */
export const AUTO_DOH_ENDPOINTS = [
  DOH_PROVIDERS["doh.pub"]!,
  DOH_PROVIDERS.alidns!,
  DOH_PROVIDERS.google!,
  DOH_PROVIDERS.cloudflare!,
];

export const DNS_STATUS_NAMES: Record<number, string> = {
  0: "NOERROR",
  1: "FORMERR",
  2: "SERVFAIL",
  3: "NXDOMAIN",
  4: "NOTIMP",
  5: "REFUSED",
};

export function dnsStatusName(status: number): string {
  return DNS_STATUS_NAMES[status] ?? `RCODE${status}`;
}

/** Resolve a preset name or URL to a DoH endpoint. Unknown names are rejected. */
export function resolveDohEndpoint(
  value: unknown
): { endpoints: string[]; error?: string } {
  const v = String(value ?? "auto").trim();
  if (!v || v.toLowerCase() === "auto") return { endpoints: AUTO_DOH_ENDPOINTS };
  const preset = DOH_PROVIDERS[v.toLowerCase()];
  if (preset) return { endpoints: [preset] };
  if (/^https?:\/\//i.test(v)) return { endpoints: [v] };
  return {
    endpoints: AUTO_DOH_ENDPOINTS,
    error: `未知 DoH 服务器: ${v}（可选 auto、google、cloudflare、quad9、alidns、doh.pub 或 URL）`,
  };
}

type DohQueryOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
};

async function queryOneDoh(
  name: string,
  type: string,
  endpoint: string,
  options: DohQueryOptions
): Promise<DohResult> {
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 10000);
  const fetcher = options.fetchImpl ?? fetch;
  const url = new URL(endpoint);
  url.searchParams.set("name", name);
  url.searchParams.set("type", type);
  // Ask for DNSSEC records so the resolver can set the AD flag.
  url.searchParams.set("do", "1");

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetcher(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/dns-json",
        "User-Agent": "pi-redteam-dns/0.1",
      },
    });
    if (!res.ok) throw new Error(`DoH HTTP ${res.status} (${endpoint})`);

    const body = (await res.json()) as {
      Status?: number;
      AD?: boolean;
      Comment?: string;
      Answer?: Array<{ name?: string; type?: number; TTL?: number; data?: string }>;
    };

    return {
      status: body.Status ?? 0,
      authenticated: body.AD === true,
      answers: (body.Answer ?? []).map((a) => ({
        name: a.name ?? name,
        type: a.type ?? 0,
        ttl: a.TTL ?? 0,
        data: a.data ?? "",
      })),
      comment: body.Comment,
      endpoint,
    };
  } catch (error) {
    if (controller.signal.aborted && options.signal?.aborted) {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }
    if (controller.signal.aborted) {
      throw new Error(`DoH timeout/${timeoutMs}ms (${endpoint})`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Query the first endpoint that answers. Each endpoint gets its own timeout,
 * so a blocked provider is skipped rather than failing the whole lookup.
 */
export async function queryDoh(
  name: string,
  type: string,
  endpoints: string[],
  options: DohQueryOptions = {}
): Promise<DohResult> {
  const list = endpoints.length > 0 ? endpoints : AUTO_DOH_ENDPOINTS;
  // Bound the whole fallback chain, not each attempt: a network that blocks
  // the first providers must not multiply the caller's timeout. Each attempt
  // also gets a slice, so a hanging provider cannot starve the rest.
  const totalTimeout = Math.max(1000, options.timeoutMs ?? 10000);
  const deadline = Date.now() + totalTimeout;
  const perAttempt = Math.max(2000, Math.ceil(totalTimeout / list.length));
  let lastError: unknown;
  for (const endpoint of list) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      return await queryOneDoh(name, type, endpoint, {
        ...options,
        timeoutMs: Math.min(Math.max(1000, remaining), perAttempt),
      });
    } catch (error) {
      if ((error as Error)?.name === "AbortError") throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("DoH 全部服务器失败");
}
