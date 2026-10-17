/**
 * DNS extension for Pi Coding Agent.
 *
 * One tool, two modes:
 * - `records` (default): active DNS lookups via the system resolver, a named
 *   nameserver, or DNS-over-HTTPS. DoH also exposes the DNSSEC AD flag.
 * - `passive`: passive DNS / certificate transparency via crt.sh, AlienVault
 *   OTX (IP path) and the Wayback CDX index, plus SecurityTrails (if
 *   configured) or HackerTarget for IP reverse lookup.
 */
import { Resolver, promises as dnsPromises } from "node:dns";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getSettingString, readSettings } from "../../_shared/settings.ts";
import {
  dnsStatusName,
  queryDoh,
  resolveDohEndpoint,
  type DohAnswer,
} from "../../_shared/doh.ts";

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

/* ------------------------------------------------------------------ *
 * records mode: DNS-over-HTTPS transport
 * ------------------------------------------------------------------ */

export type DnsTransport = "auto" | "system" | "doh";

export function normalizeTransport(raw: unknown): DnsTransport | undefined {
  const v = String(raw ?? "auto").trim().toLowerCase();
  if (!v || v === "auto") return "auto";
  if (v === "system" || v === "dns") return "system";
  if (v === "doh" || v === "https") return "doh";
  return undefined;
}

/** Optional DoH endpoint: settings.json `redteam.dns-lookup.dohServer`. */
export function loadDohServer(): string | undefined {
  return getSettingString(readSettings(), "redteam.dns-lookup.dohServer");
}

/** Build the `.in-addr.arpa` / `.ip6.arpa` name used for PTR queries. */
export function reverseName(ip: string): string {
  const clean = ip.trim().replace(/^\[|\]$/g, "").split("%")[0]!.toLowerCase();
  if (IPV4.test(clean)) {
    return `${clean.split(".").reverse().join(".")}.in-addr.arpa`;
  }
  const halves = clean.split("::");
  if (halves.length > 2) throw new Error(`无效 IPv6: ${ip}`);
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) throw new Error(`无效 IPv6: ${ip}`);
  const groups = [
    ...head,
    ...Array.from({ length: missing }, () => "0"),
    ...tail,
  ];
  const nibbles = groups
    .flatMap((group) => group.padStart(4, "0").split(""))
    .reverse();
  return `${nibbles.join(".")}.ip6.arpa`;
}

const TYPE_NUMBERS: Record<DnsType, number> = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  PTR: 12,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  CAA: 257,
};

function unquoteTxt(data: string): string {
  const quoted = data.match(/"(?:[^"\\]|\\.)*"/g);
  if (!quoted?.length) return data;
  return quoted
    .map((part) => part.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\"))
    .join("");
}

/** Convert DoH `Answer[]` into the same shapes the system resolver returns. */
export function parseDohAnswers(type: DnsType, answers: DohAnswer[]): unknown[] {
  const matching = answers.filter((answer) => answer.type === TYPE_NUMBERS[type]);
  const noDot = (value: string) => value.replace(/\.$/, "");

  switch (type) {
    case "A":
    case "AAAA":
    case "NS":
    case "CNAME":
    case "PTR":
      return matching.map((answer) => noDot(answer.data));
    case "MX":
      return matching.map((answer) => {
        const m = answer.data.match(/^(\d+)\s+(\S+)$/);
        return m
          ? { priority: Number(m[1]), exchange: noDot(m[2]!) }
          : answer.data;
      });
    case "TXT":
      return matching.map((answer) => unquoteTxt(answer.data));
    case "SOA":
      return matching.map((answer) => {
        const p = answer.data.trim().split(/\s+/);
        if (p.length < 7) return answer.data;
        return {
          nsname: noDot(p[0]!),
          hostmaster: noDot(p[1]!),
          serial: Number(p[2]),
          refresh: Number(p[3]),
          retry: Number(p[4]),
          expire: Number(p[5]),
          minttl: Number(p[6]),
        };
      });
    case "SRV":
      return matching.map((answer) => {
        const p = answer.data.trim().split(/\s+/);
        if (p.length < 4) return answer.data;
        return {
          priority: Number(p[0]),
          weight: Number(p[1]),
          port: Number(p[2]),
          name: noDot(p[3]!),
        };
      });
    case "CAA":
      return matching.map((answer) => {
        const m = answer.data.match(/^(\d+)\s+(\S+)\s+"?(.*?)"?$/);
        return m ? { critical: Number(m[1]), [m[2]!]: m[3] } : answer.data;
      });
    default:
      return matching.map((answer) => answer.data);
  }
}

async function resolveViaDoh(
  host: string,
  isIp: boolean,
  type: DnsType,
  endpoints: string[],
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ value: unknown; authenticated?: boolean; endpoint: string }> {
  if (isIp && type !== "PTR") {
    if (type === "A") {
      return { value: IPV4.test(host) ? [host] : [], endpoint: "" };
    }
    if (type === "AAAA") {
      return { value: IPV4.test(host) ? [] : [host], endpoint: "" };
    }
    return { value: [], endpoint: "" };
  }
  if (type === "PTR" && !isIp) return { value: [], endpoint: "" };

  const name = type === "PTR" ? reverseName(host) : host;
  const result = await queryDoh(name, type, endpoints, { timeoutMs, signal });
  if (result.status !== 0) {
    throw new Error(`${dnsStatusName(result.status)} (${result.status})`);
  }
  return {
    value: parseDohAnswers(type, result.answers),
    authenticated: result.authenticated,
    endpoint: result.endpoint,
  };
}

async function runRecords(
  raw: string,
  params: {
    types?: string[];
    nameserver?: string;
    transport?: string;
    doh_server?: string;
    timeout_seconds?: number;
  },
  signal?: AbortSignal
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

  const requestedTransport = normalizeTransport(params.transport);
  if (!requestedTransport) {
    return {
      content: [
        {
          type: "text",
          text: `不支持的 transport: ${params.transport}（可选 auto、system、doh）`,
        },
      ],
      details: {},
      isError: true,
    };
  }

  const nameserver = params.nameserver?.trim() || undefined;
  const doh = resolveDohEndpoint(params.doh_server ?? loadDohServer() ?? "auto");
  if (doh.error && !nameserver && requestedTransport === "doh") {
    return {
      content: [{ type: "text", text: doh.error }],
      details: {},
      isError: true,
    };
  }

  const dohTimeoutMs = Math.max(3, params.timeout_seconds ?? 12) * 1000;
  const requested = (params.types?.length
    ? params.types.map((t) => t.toUpperCase())
    : [...DEFAULT_TYPES]) as string[];

  const records: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  const dnssecChecks: boolean[] = [];
  let transportUsed: "system" | "doh" = "system";
  let nameserverUsed = nameserver ?? "system";
  let dohEndpoint: string | undefined;

  async function runAll(resolve: (type: DnsType) => Promise<unknown>) {
    for (const type of requested) {
      if (!(ALL_TYPES as readonly string[]).includes(type)) {
        errors[type] = "unsupported type";
        continue;
      }
      try {
        records[type] = await resolve(type as DnsType);
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

  function resetResults() {
    Object.keys(records).forEach((key) => delete records[key]);
    Object.keys(errors).forEach((key) => delete errors[key]);
  }

  function transportFailed(): boolean {
    return Object.values(errors).some((message) =>
      /ECONNREFUSED|ETIMEDOUT|ETIMEOUT|ENOTFOUND|EAI_AGAIN|ESERVFAIL/i.test(message)
    );
  }

  const systemApi = createDnsApi(nameserver);
  const runSystem = () => {
    transportUsed = "system";
    nameserverUsed = nameserver ?? "system";
    return runAll((type) => resolveOne(systemApi, host, isIp, type));
  };
  const runDoh = () => {
    transportUsed = "doh";
    dnssecChecks.length = 0;
    return runAll(async (type) => {
      const result = await resolveViaDoh(
        host,
        isIp,
        type,
        doh.endpoints,
        dohTimeoutMs,
        signal
      );
      if (result.endpoint) dohEndpoint = result.endpoint;
      if (result.authenticated !== undefined) {
        dnssecChecks.push(result.authenticated);
      }
      return result.value;
    });
  };

  if (nameserver) {
    // An explicit resolver address always means the system resolver path.
    await runSystem();
  } else if (requestedTransport === "doh") {
    await runDoh();
  } else {
    await runSystem();
    if (requestedTransport === "auto" && transportFailed()) {
      resetResults();
      await runDoh();
    } else if (requestedTransport === "system" && transportFailed()) {
      // System resolver often broken on locked-down Windows — retry via 8.8.8.8
      resetResults();
      nameserverUsed = "8.8.8.8 (fallback)";
      const fallbackApi = createDnsApi("8.8.8.8");
      await runAll((type) => resolveOne(fallbackApi, host, isIp, type));
    }
  }

  const payload = {
    mode: "records",
    target: raw.trim(),
    host,
    isIp,
    transport: transportUsed,
    nameserver: nameserverUsed,
    ...(transportUsed === "doh"
      ? { dohServer: dohEndpoint ?? doh.endpoints[0] }
      : {}),
    ...(transportUsed === "doh" && dnssecChecks.length > 0
      ? {
          dnssec: {
            authenticated: dnssecChecks.every(Boolean),
            checked: dnssecChecks.length,
          },
        }
      : {}),
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

/* ------------------------------------------------------------------ *
 * passive mode: additional free sources
 * ------------------------------------------------------------------ */

export type PassiveSource = "crt.sh" | "otx" | "wayback";

/**
 * Defaults differ by target type because OTX's domain endpoint now requires
 * authentication, while its IPv4 endpoint still answers anonymously.
 */
export function normalizePassiveSources(
  raw: unknown,
  kind: "domain" | "ip" = "domain"
): PassiveSource[] {
  const defaults: PassiveSource[] =
    kind === "domain" ? ["crt.sh", "wayback"] : ["crt.sh", "otx"];
  const items = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(",")
      : [];
  const out = new Set<PassiveSource>();
  for (const item of items) {
    const v = String(item).trim().toLowerCase();
    if (!v) continue;
    if (v === "all") return kind === "domain"
      ? ["crt.sh", "otx", "wayback"]
      : ["crt.sh", "otx", "wayback"];
    if (v === "crt.sh" || v === "crtsh" || v === "crt") out.add("crt.sh");
    else if (v === "otx" || v === "alienvault") out.add("otx");
    else if (v === "wayback" || v === "web.archive.org") out.add("wayback");
  }
  return out.size > 0 ? [...out] : defaults;
}

export function parseOtxPassiveDns(body: unknown): string[] {
  const rows = (body as { passive_dns?: Array<{ hostname?: unknown }> })
    ?.passive_dns;
  if (!Array.isArray(rows)) return [];
  return uniqSorted(
    rows
      .map((row) => String(row?.hostname ?? "").trim().replace(/^\*\./, ""))
      .filter((name) => name && !name.includes(" ")),
    500
  );
}

async function queryOtx(
  target: string,
  kind: "domain" | "ip",
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ names: string[]; count: number; error?: string }> {
  const path = kind === "ip" ? "IPv4" : "domain";
  const url = `https://otx.alienvault.com/api/v1/indicators/${path}/${encodeURIComponent(target)}/passive_dns`;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "pi-redteam-dns/0.1",
      },
    });
    if (!res.ok) {
      return { names: [], count: 0, error: `otx HTTP ${res.status}` };
    }
    const body = (await res.json()) as {
      detail?: unknown;
      passive_dns?: unknown[];
    };
    if (body?.detail) {
      return {
        names: [],
        count: 0,
        error: `otx: ${String(body.detail).slice(0, 160)}`,
      };
    }
    const count = Array.isArray(body?.passive_dns) ? body.passive_dns.length : 0;
    return { names: parseOtxPassiveDns(body), count };
  } catch (error) {
    const timedOut = controller.signal.aborted && !signal?.aborted;
    return {
      names: [],
      count: 0,
      error: timedOut
        ? `otx timeout/${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error),
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Extract in-scope hostnames from a Wayback CDX JSON response. */
export function parseWaybackHostnames(body: unknown, domain: string): string[] {
  if (!Array.isArray(body)) return [];
  const hosts: string[] = [];
  for (const row of body) {
    const original = Array.isArray(row) ? row[0] : undefined;
    if (typeof original !== "string") continue;
    try {
      const host = stripPort(new URL(original).hostname).toLowerCase();
      if (host === domain || host.endsWith(`.${domain}`)) hosts.push(host);
    } catch {
      /* the first row is a header, and malformed URLs are not evidence */
    }
  }
  return uniqSorted(hosts, 500);
}

async function queryWayback(
  domain: string,
  timeoutMs: number,
  signal?: AbortSignal,
  max = 500
): Promise<{ names: string[]; count: number; error?: string }> {
  const url = new URL("https://web.archive.org/cdx/search/cdx");
  url.searchParams.set("url", domain);
  url.searchParams.set("matchType", "domain");
  url.searchParams.set("output", "json");
  url.searchParams.set("fl", "original");
  url.searchParams.set("collapse", "urlkey");
  url.searchParams.set("limit", String(max));

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "pi-redteam-dns/0.1",
      },
    });
    if (!res.ok) {
      return { names: [], count: 0, error: `wayback HTTP ${res.status}` };
    }
    const text = await res.text();
    if (!text.trim()) return { names: [], count: 0 };
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { names: [], count: 0, error: "wayback returned non-JSON" };
    }
    const names = parseWaybackHostnames(body, domain);
    return { names, count: names.length };
  } catch (error) {
    const timedOut = controller.signal.aborted && !signal?.aborted;
    return {
      names: [],
      count: 0,
      error: timedOut
        ? `wayback timeout/${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error),
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

type SourceResult = {
  provider: string;
  names: string[];
  count: number;
  error?: string;
};

async function settleSource(
  provider: string,
  promise: Promise<{ names: string[]; count: number; error?: string }>
): Promise<SourceResult> {
  try {
    return { provider, ...(await promise) };
  } catch (error) {
    return {
      provider,
      names: [],
      count: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runPassive(
  raw: string,
  params: {
    timeout_seconds?: number;
    limit?: number;
    sources?: unknown;
  },
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
  const sourceTimeoutMs = Math.min(timeoutMs, 15000);
  const limit = Math.max(1, Math.min(500, params.limit ?? 100));
  const sources: Array<Record<string, unknown>> = [];

  try {
    if (resolved.kind === "domain") {
      const selected = normalizePassiveSources(params.sources, "domain");
      const jobs: Array<Promise<SourceResult>> = [];
      if (selected.includes("crt.sh")) {
        jobs.push(settleSource("crt.sh", queryCrtSh(resolved.target, sourceTimeoutMs, signal)));
      }
      if (selected.includes("otx")) {
        jobs.push(settleSource("otx", queryOtx(resolved.target, "domain", sourceTimeoutMs, signal)));
      }
      if (selected.includes("wayback")) {
        jobs.push(settleSource("wayback", queryWayback(resolved.target, sourceTimeoutMs, signal, 500)));
      }

      const results = await Promise.all(jobs);
      for (const result of results) {
        sources.push({
          provider: result.provider,
          query: resolved.target,
          recordCount: result.count,
          error: result.error,
        });
      }

      const domains = uniqSorted(
        results.flatMap((result) => result.names),
        limit
      );
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
        isError:
          domains.length === 0 &&
          results.length > 0 &&
          results.every((result) => result.error),
      };
    }

    // IP path
    const selected = normalizePassiveSources(params.sources, "ip");
    const crtTask = selected.includes("crt.sh")
      ? settleSource("crt.sh", queryCrtSh(resolved.target, sourceTimeoutMs, signal))
      : null;
    const otxTask = selected.includes("otx")
      ? settleSource("otx", queryOtx(resolved.target, "ip", sourceTimeoutMs, signal))
      : null;

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

    const crt = crtTask ? await crtTask : null;
    if (crt) {
      sources.push({
        provider: crt.provider,
        query: resolved.target,
        recordCount: crt.count,
        error: crt.error,
      });
      domains = uniqSorted([...domains, ...crt.names], limit);
    }

    const otx = otxTask ? await otxTask : null;
    if (otx) {
      sources.push({
        provider: otx.provider,
        query: resolved.target,
        recordCount: otx.count,
        error: otx.error,
      });
      domains = uniqSorted([...domains, ...otx.names], limit);
    }

    domains = domains.slice(0, limit);

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
      "DNS 查询工具。mode=records（默认）主动查询记录（A/AAAA/PTR/NS/MX/TXT/CNAME/SOA/SRV/CAA），支持 nameserver、DoH（含 DNSSEC AD）与 IPv6 PTR；mode=passive 被动 DNS：crt.sh + Wayback，IP 另查 OTX/SecurityTrails/HackerTarget。",
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
      transport: Type.Optional(
        Type.String({
          description:
            "records 传输方式：auto（默认，系统失败时走 DoH）| system | doh",
        })
      ),
      doh_server: Type.Optional(
        Type.String({
          description:
            "DoH 服务器：auto（默认）| google | cloudflare | quad9 | alidns | doh.pub | URL",
        })
      ),
      sources: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "passive 数据源：crt.sh、otx、wayback、all；默认域名 crt.sh+wayback，IP crt.sh+otx",
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
      if (mode === "records") return runRecords(raw, params, signal);
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
