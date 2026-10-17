/**
 * DNS extension for Pi Coding Agent.
 *
 * One tool, two modes:
 * - `records` (default): active DNS lookups via the system resolver or a
 *   named nameserver. No API key required.
 * - `passive`: passive DNS / certificate transparency via crt.sh, plus
 *   SecurityTrails (if configured) or HackerTarget for IP reverse lookup.
 */
import { Resolver, promises as dnsPromises } from "node:dns";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getSettingString, readSettings } from "../../_shared/settings.ts";

const IPV4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const IPV6 =
  /^(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$|^\[.+\]$/;

/* ------------------------------------------------------------------ *
 * Shared target parsing
 * ------------------------------------------------------------------ */

export function stripPort(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end >= 0 ? host.slice(1, end) : host;
  }
  const colon = host.lastIndexOf(":");
  if (colon > 0 && !host.includes("]")) {
    const maybePort = host.slice(colon + 1);
    if (/^\d+$/.test(maybePort)) return host.slice(0, colon);
  }
  return host;
}

export function isIpAddress(host: string): boolean {
  return IPV4.test(host) || (host.includes(":") && !host.includes("."));
}

/* ------------------------------------------------------------------ *
 * records mode
 * ------------------------------------------------------------------ */

export const ALL_TYPES = [
  "A",
  "AAAA",
  "PTR",
  "NS",
  "MX",
  "TXT",
  "CNAME",
  "SOA",
  "SRV",
  "CAA",
] as const;
type DnsType = (typeof ALL_TYPES)[number];

export const DEFAULT_TYPES: DnsType[] = ["A", "AAAA", "PTR", "NS", "MX", "TXT", "CNAME", "SOA"];

export function resolveHost(input: string): { host: string; isIp: boolean } {
  const raw = input.trim();
  if (!raw) throw new Error("缺少 target 或 input");
  if (IPV4.test(raw)) return { host: raw, isIp: true };
  if (raw.startsWith("[") && raw.includes("]")) {
    const inner = stripPort(raw);
    return { host: inner, isIp: true };
  }
  if (IPV6.test(raw) || (raw.includes(":") && !raw.includes("."))) {
    return { host: raw.replace(/^\[|\]$/g, ""), isIp: true };
  }
  try {
    const withScheme = raw.includes("://") ? raw : `https://${raw}`;
    const url = new URL(withScheme);
    const host = stripPort(url.hostname);
    return { host, isIp: isIpAddress(host) };
  } catch {
    const host = stripPort(raw.split("/")[0] ?? raw);
    if (!host) throw new Error(`无法解析: ${raw}`);
    return { host, isIp: isIpAddress(host) };
  }
}

type DnsApi = {
  resolve4: (h: string) => Promise<string[]>;
  resolve6: (h: string) => Promise<string[]>;
  resolveNs: (h: string) => Promise<string[]>;
  resolveMx: (h: string) => Promise<Array<{ exchange: string; priority: number }>>;
  resolveTxt: (h: string) => Promise<string[][]>;
  resolveCname: (h: string) => Promise<string[]>;
  resolveSoa: (h: string) => Promise<Record<string, unknown>>;
  resolveSrv: (h: string) => Promise<unknown[]>;
  resolveCaa: (h: string) => Promise<unknown[]>;
  reverse: (h: string) => Promise<string[]>;
};

function createDnsApi(nameserver?: string): DnsApi {
  if (!nameserver?.trim()) {
    return {
      resolve4: (h) => dnsPromises.resolve4(h),
      resolve6: (h) => dnsPromises.resolve6(h),
      resolveNs: (h) => dnsPromises.resolveNs(h),
      resolveMx: (h) => dnsPromises.resolveMx(h),
      resolveTxt: (h) => dnsPromises.resolveTxt(h),
      resolveCname: (h) => dnsPromises.resolveCname(h),
      resolveSoa: (h) => dnsPromises.resolveSoa(h) as unknown as Promise<Record<string, unknown>>,
      resolveSrv: (h) => dnsPromises.resolveSrv(h),
      resolveCaa: (h) => dnsPromises.resolveCaa(h),
      reverse: (h) => dnsPromises.reverse(h),
    };
  }

  const resolver = new Resolver();
  resolver.setServers([nameserver.trim()]);
  return {
    resolve4: promisify(resolver.resolve4.bind(resolver)) as DnsApi["resolve4"],
    resolve6: promisify(resolver.resolve6.bind(resolver)) as DnsApi["resolve6"],
    resolveNs: promisify(resolver.resolveNs.bind(resolver)) as DnsApi["resolveNs"],
    resolveMx: promisify(resolver.resolveMx.bind(resolver)) as DnsApi["resolveMx"],
    resolveTxt: promisify(resolver.resolveTxt.bind(resolver)) as DnsApi["resolveTxt"],
    resolveCname: promisify(resolver.resolveCname.bind(resolver)) as DnsApi["resolveCname"],
    resolveSoa: promisify(resolver.resolveSoa.bind(resolver)) as unknown as DnsApi["resolveSoa"],
    resolveSrv: promisify(resolver.resolveSrv.bind(resolver)) as DnsApi["resolveSrv"],
    resolveCaa: promisify(resolver.resolveCaa.bind(resolver)) as DnsApi["resolveCaa"],
    reverse: promisify(resolver.reverse.bind(resolver)) as DnsApi["reverse"],
  };
}

async function resolveOne(
  api: DnsApi,
  host: string,
  isIp: boolean,
  type: DnsType
): Promise<unknown> {
  switch (type) {
    case "A":
      if (isIp) return IPV4.test(host) ? [host] : [];
      return api.resolve4(host);
    case "AAAA":
      if (isIp) return IPV4.test(host) ? [] : [host];
      return api.resolve6(host);
    case "PTR":
      if (!isIp) return [];
      return api.reverse(host);
    case "NS":
      if (isIp) return [];
      return api.resolveNs(host);
    case "MX":
      if (isIp) return [];
      return api.resolveMx(host);
    case "TXT":
      if (isIp) return [];
      return (await api.resolveTxt(host)).map((parts) => parts.join(""));
    case "CNAME":
      if (isIp) return [];
      return api.resolveCname(host);
    case "SOA":
      if (isIp) return [];
      return api.resolveSoa(host);
    case "SRV":
      if (isIp) return [];
      // Node expects full name e.g. _sip._tcp.example.com — pass through as-is
      return api.resolveSrv(host);
    case "CAA":
      if (isIp) return [];
      return api.resolveCaa(host);
    default:
      return [];
  }
}

async function runRecords(
  raw: string,
  params: {
    types?: string[];
    nameserver?: string;
  }
) {
  let host: string;
  let isIp: boolean;
  try {
    ({ host, isIp } = resolveHost(raw));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: message }],
      details: {},
      isError: true,
    };
  }

  const nameserver = params.nameserver?.trim() || undefined;
  let api = createDnsApi(nameserver);
  let usedNs = nameserver ?? "system";

  const requested = (params.types?.length
    ? params.types.map((t) => t.toUpperCase())
    : [...DEFAULT_TYPES]) as string[];

  const records: Record<string, unknown> = {};
  const errors: Record<string, string> = {};

  async function runAll(dnsApi: DnsApi) {
    for (const type of requested) {
      if (!(ALL_TYPES as readonly string[]).includes(type)) {
        errors[type] = "unsupported type";
        continue;
      }
      try {
        records[type] = await resolveOne(dnsApi, host, isIp, type as DnsType);
        delete errors[type];
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? String((error as { code?: string }).code)
            : undefined;
        errors[type] =
          code ?? (error instanceof Error ? error.message : String(error));
      }
    }
  }

  await runAll(api);

  // System resolver often broken on locked-down Windows — retry via public DNS
  const transportFail = Object.values(errors).some((m) =>
    /ECONNREFUSED|ETIMEOUT|ENOTFOUND|EAI_AGAIN/i.test(m)
  );
  if (!nameserver && transportFail) {
    usedNs = "8.8.8.8 (fallback)";
    api = createDnsApi("8.8.8.8");
    Object.keys(records).forEach((k) => delete records[k]);
    Object.keys(errors).forEach((k) => delete errors[k]);
    await runAll(api);
  }

  const payload = {
    mode: "records",
    target: raw.trim(),
    host,
    isIp,
    nameserver: usedNs,
    records,
    ...(Object.keys(errors).length ? { errors } : {}),
  };

  const hasAny = Object.values(records).some((v) =>
    Array.isArray(v) ? v.length > 0 : v != null && v !== ""
  );

  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
    isError: !hasAny && Object.keys(errors).length > 0,
  };
}

/* ------------------------------------------------------------------ *
 * passive mode
 * ------------------------------------------------------------------ */

export function resolveTarget(input: string): {
  target: string;
  kind: "ip" | "domain";
} {
  const raw = input.trim();
  if (!raw) throw new Error("缺少 target 或 input");

  let host = raw;
  if (/^https?:\/\//i.test(raw)) {
    host = new URL(raw).hostname;
  } else if (raw.includes("/") && !raw.includes(" ")) {
    host = raw.split("/")[0]!;
  }
  host = stripPort(host).replace(/^\[|\]$/g, "");

  if (IPV4.test(host)) return { target: host, kind: "ip" };
  if (host.includes(":") && !host.includes(".")) {
    throw new Error("passive 模式暂仅支持 IPv4 IP 或域名（IPv6 请用域名路径）");
  }
  return { target: host.toLowerCase(), kind: "domain" };
}

/**
 * SecurityTrails API key: settings.json `redteam.dns-lookup.securityTrailsKey`.
 *
 * Returning `undefined` is a supported state, not a failure — the IP path
 * falls back to HackerTarget and reports `configuredSecurityTrails: false`.
 */
export function loadSecurityTrailsKey(): string | undefined {
  return getSettingString(readSettings(), "redteam.dns-lookup.securityTrailsKey");
}

function uniqSorted(items: string[], limit: number): string[] {
  return [...new Set(items.map((s) => s.trim().toLowerCase()).filter(Boolean))]
    .sort()
    .slice(0, limit);
}

type CrtRow = { name_value?: string; common_name?: string };

export function parseCrtShNames(rows: CrtRow[], limit = 200): string[] {
  const names: string[] = [];
  for (const row of rows) {
    for (const part of String(row.name_value ?? "").split("\n")) {
      const n = part.trim().replace(/^\*\./, "");
      if (n && !n.includes(" ")) names.push(n);
    }
    if (row.common_name) {
      const n = row.common_name.trim().replace(/^\*\./, "");
      if (n) names.push(n);
    }
  }
  return uniqSorted(names, limit);
}

async function queryCrtSh(
  query: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ names: string[]; error?: string; count: number }> {
  const url = `https://crt.sh/?q=${encodeURIComponent(query)}&output=json`;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "pi-redteam-dns/0.1" },
    });
    if (!res.ok) {
      return { names: [], error: `crt.sh HTTP ${res.status}`, count: 0 };
    }
    const text = await res.text();
    if (!text.trim()) return { names: [], count: 0 };
    let rows: CrtRow[];
    try {
      rows = JSON.parse(text) as CrtRow[];
    } catch {
      return { names: [], error: "crt.sh returned non-JSON", count: 0 };
    }
    if (!Array.isArray(rows)) return { names: [], count: 0 };
    const names = parseCrtShNames(rows);
    return { names, count: rows.length };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function queryHackerTargetReverseIp(
  ip: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ domains: string[]; error?: string }> {
  const url = `https://api.hackertarget.com/reverseiplookup/?q=${encodeURIComponent(ip)}`;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "pi-redteam-dns/0.1" },
    });
    const text = (await res.text()).trim();
    if (!res.ok) return { domains: [], error: `hackertarget HTTP ${res.status}` };
    if (/^error/i.test(text) || /API count exceeded/i.test(text)) {
      return { domains: [], error: text.slice(0, 200) };
    }
    const domains = uniqSorted(
      text.split(/\r?\n/).filter((l) => l && !l.includes(" ")),
      200
    );
    return { domains };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function querySecurityTrailsIp(
  ip: string,
  apiKey: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ domains: string[]; error?: string }> {
  // SecurityTrails: GET /v1/ips/{ip}/hostnames
  const hostUrl = `https://api.securitytrails.com/v1/ips/${encodeURIComponent(ip)}/hostnames`;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(hostUrl, {
      signal: controller.signal,
      headers: {
        APIKEY: apiKey,
        Accept: "application/json",
        "User-Agent": "pi-redteam-dns/0.1",
      },
    });
    if (!res.ok) {
      return { domains: [], error: `securitytrails HTTP ${res.status}: ${(await res.text()).slice(0, 160)}` };
    }
    const data = (await res.json()) as {
      hostnames?: Array<string | { hostname?: string; value?: string }>;
      records?: Array<{ hostname?: string }>;
    };
    const raw: string[] = [];
    for (const h of data.hostnames ?? data.records ?? []) {
      if (typeof h === "string") raw.push(h);
      else if (h?.hostname) raw.push(h.hostname);
      else if (h && "value" in h && typeof h.value === "string") raw.push(h.value);
    }
    return { domains: uniqSorted(raw, 200) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function runPassive(
  raw: string,
  params: { timeout_seconds?: number; limit?: number },
  signal?: AbortSignal
) {
  let resolved: { target: string; kind: "ip" | "domain" };
  try {
    resolved = resolveTarget(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: message }],
      details: {},
      isError: true,
    };
  }

  const timeoutMs = Math.max(5, params.timeout_seconds ?? 25) * 1000;
  const limit = Math.max(1, Math.min(500, params.limit ?? 100));
  const sources: Array<Record<string, unknown>> = [];

  try {
    if (resolved.kind === "domain") {
      const crt = await queryCrtSh(resolved.target, timeoutMs, signal);
      sources.push({
        provider: "crt.sh",
        query: resolved.target,
        recordCount: crt.count,
        error: crt.error,
      });
      const domains = crt.names.slice(0, limit);
      const payload = {
        mode: "passive",
        target: raw.trim(),
        host: resolved.target,
        kind: "domain",
        domains,
        count: domains.length,
        sources,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        details: payload,
        isError: Boolean(crt.error && domains.length === 0),
      };
    }

    // IP path
    const stKey = loadSecurityTrailsKey();
    let domains: string[] = [];

    if (stKey) {
      const st = await querySecurityTrailsIp(resolved.target, stKey, timeoutMs, signal);
      sources.push({
        provider: "securitytrails",
        query: resolved.target,
        count: st.domains.length,
        error: st.error,
      });
      domains = st.domains;
    }

    if (domains.length === 0) {
      const ht = await queryHackerTargetReverseIp(resolved.target, timeoutMs, signal);
      sources.push({
        provider: "hackertarget",
        query: resolved.target,
        count: ht.domains.length,
        error: ht.error,
      });
      domains = ht.domains;
    }

    // Also try crt.sh with IP identity (often empty, cheap)
    const crt = await queryCrtSh(resolved.target, Math.min(timeoutMs, 15000), signal);
    sources.push({
      provider: "crt.sh",
      query: resolved.target,
      recordCount: crt.count,
      error: crt.error,
    });
    if (crt.names.length) {
      domains = uniqSorted([...domains, ...crt.names], limit);
    } else {
      domains = domains.slice(0, limit);
    }

    const payload = {
      mode: "passive",
      target: raw.trim(),
      host: resolved.target,
      kind: "ip",
      domains,
      count: domains.length,
      configuredSecurityTrails: Boolean(stKey),
      sources,
      hint:
        domains.length === 0
          ? "无被动关联域名；可能是纯接入网段/家庭宽带，或源限流。可结合 PTR/FOFA 同段抽样。"
          : undefined,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      details: payload,
    };
  } catch (error) {
    const aborted = signal?.aborted;
    const message =
      aborted || (error instanceof Error && error.name === "AbortError")
        ? `timeout/${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error);
    const err = {
      mode: "passive",
      error: true,
      message,
      target: raw.trim(),
      host: resolved.target,
      kind: resolved.kind,
      sources,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(err, null, 2) }],
      details: err,
      isError: true,
    };
  }
}

/* ------------------------------------------------------------------ *
 * Tool registration
 * ------------------------------------------------------------------ */

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "dns_lookup",
    label: "DNS Lookup",
    description:
      "DNS 查询工具。mode=records（默认）主动查询记录（A/AAAA/PTR/NS/MX/TXT/CNAME/SOA/SRV/CAA），支持 nameserver 指定解析器与 IPv6 PTR；mode=passive 被动 DNS/证书透明度：域名查 crt.sh，IP 查历史关联域名。",
    parameters: Type.Object({
      target: Type.Optional(Type.String({ description: "IP、域名或 URL" })),
      input: Type.Optional(Type.String({ description: "IP、域名或 URL" })),
      mode: Type.Optional(
        Type.String({
          description:
            "records（默认，主动查询）或 passive（被动 DNS / 证书透明度）",
        })
      ),
      types: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "records 模式记录类型，默认 A,AAAA,PTR,NS,MX,TXT,CNAME,SOA；可选 SRV,CAA",
        })
      ),
      nameserver: Type.Optional(
        Type.String({
          description:
            "records 模式可选 DNS 服务器 IP（如 8.8.8.8 / 1.1.1.1），省略用系统解析器",
        })
      ),
      timeout_seconds: Type.Optional(
        Type.Number({ description: "passive 模式超时秒数，默认 25" })
      ),
      limit: Type.Optional(
        Type.Number({ description: "passive 模式返回域名上限，默认 100" })
      ),
    }),
    async execute(_id, params, signal) {
      const raw = params.target ?? params.input;
      if (!raw?.trim()) {
        return {
          content: [{ type: "text", text: "缺少 target 或 input 参数" }],
          details: {},
          isError: true,
        };
      }

      const mode = (params.mode ?? "records").trim().toLowerCase();
      if (mode === "records") return runRecords(raw, params);
      if (mode === "passive") return runPassive(raw, params, signal);

      return {
        content: [
          {
            type: "text",
            text: `不支持的 mode: ${mode}（可选 records、passive）`,
          },
        ],
        details: {},
        isError: true,
      };
    },
  });
}
