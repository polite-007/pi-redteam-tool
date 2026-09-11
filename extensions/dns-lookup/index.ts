/**
 * DNS Lookup extension for Pi Coding Agent.
 * Query DNS records (A/AAAA/PTR/NS/MX/TXT/CNAME/SOA/SRV/CAA).
 * Uses system DNS, no API key required.
 */
import { Resolver, promises as dnsPromises } from "node:dns";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const IPV4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const IPV6 =
  /^(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$|^\[.+\]$/;

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

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "dns_lookup",
    label: "DNS Lookup",
    description:
      "查询 DNS（A/AAAA/PTR/NS/MX/TXT/CNAME/SOA/SRV/CAA）。支持 nameserver 指定权威解析；IP 含 IPv6 可做 PTR。",
    parameters: Type.Object({
      target: Type.Optional(Type.String({ description: "IP、域名或 URL" })),
      input: Type.Optional(Type.String({ description: "IP、域名或 URL" })),
      types: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "记录类型，默认 A,AAAA,PTR,NS,MX,TXT,CNAME,SOA；可选 SRV,CAA",
        })
      ),
      nameserver: Type.Optional(
        Type.String({
          description: "可选 DNS 服务器 IP（如 8.8.8.8 / 1.1.1.1），省略用系统解析器",
        })
      ),
    }),
    async execute(_id, params) {
      const raw = params.target ?? params.input;
      if (!raw?.trim()) {
        return {
          content: [{ type: "text", text: "缺少 target 或 input 参数" }],
          details: {},
          isError: true,
        };
      }

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
    },
  });
}
