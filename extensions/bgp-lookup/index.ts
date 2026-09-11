/**
 * BGP Lookup extension for Pi Coding Agent.
 * BGP/ASN lookup via BGPView API.
 * Helps distinguish customer-access prefixes vs infrastructure / transit.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const IPV4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

function stripPort(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end >= 0 ? host.slice(0, end + 1) : host;
  }
  const colon = host.lastIndexOf(":");
  if (colon > 0 && !host.includes("]")) {
    const maybePort = host.slice(colon + 1);
    if (/^\d+$/.test(maybePort)) return host.slice(0, colon);
  }
  return host;
}

export function resolveIp(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error("缺少 target / input / ip");
  let host = raw;
  if (/^https?:\/\//i.test(raw)) host = new URL(raw).hostname;
  else if (raw.includes("/") && !raw.includes(" ")) host = raw.split("/")[0]!;
  host = stripPort(host).replace(/^\[|\]$/g, "");
  if (!IPV4.test(host)) throw new Error("bgp_lookup 目前仅支持 IPv4");
  return host;
}

export type BgpUsageClass =
  | "customer_access"
  | "infrastructure"
  | "transit_or_isp"
  | "unknown";

export function prefixLengthFromCidr(cidr: string | undefined): number | undefined {
  if (!cidr) return undefined;
  const m = cidr.match(/\/(\d+)$/);
  if (!m) return undefined;
  return Number(m[1]);
}

/**
 * Heuristic: residential/broadband prefixes are often longer (/22-/28);
 * transit/infra often shorter or keyworded as backbone/transit/ix.
 */
export function classifyBgpUsage(input: {
  prefix?: string;
  prefixLen?: number;
  asnName?: string;
  asnDescription?: string;
  prefixName?: string;
  prefixDescription?: string;
}): {
  classification: BgpUsageClass;
  reasons: string[];
} {
  const reasons: string[] = [];
  const blob = [
    input.asnName,
    input.asnDescription,
    input.prefixName,
    input.prefixDescription,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const len = input.prefixLen ?? prefixLengthFromCidr(input.prefix);

  const customerHints =
    /broadband|dialup|adsl|ftth|fiber.?to.?the.?home|residential|dynamic|customer|pool|pppoe|catv|mobile|lte|5g|access|consumer|home/i;
  const infraHints =
    /backbone|transit|core|ixp|peering|cdn|anycast|datacenter|data.?centre|hosting|cloud|infra|noc|pop\b|router|dns.?anycast/i;

  let scoreCustomer = 0;
  let scoreInfra = 0;

  if (customerHints.test(blob)) {
    scoreCustomer += 2;
    reasons.push("name/description suggests access/broadband/customer");
  }
  if (infraHints.test(blob)) {
    scoreInfra += 2;
    reasons.push("name/description suggests backbone/transit/infra");
  }
  if (typeof len === "number") {
    if (len >= 22 && len <= 28) {
      scoreCustomer += 1;
      reasons.push(`prefix length /${len} typical of access pools`);
    } else if (len > 0 && len <= 16) {
      scoreInfra += 1;
      reasons.push(`prefix length /${len} often infrastructure/transit aggregation`);
    } else if (len >= 17 && len <= 21) {
      reasons.push(`prefix length /${len} ambiguous (ISP aggregate or enterprise)`);
    }
  }

  if (scoreCustomer === 0 && scoreInfra === 0) {
    return { classification: "unknown", reasons: reasons.length ? reasons : ["insufficient signals"] };
  }
  if (scoreCustomer > scoreInfra) {
    return { classification: "customer_access", reasons };
  }
  if (scoreInfra > scoreCustomer) {
    // If ISP keywords without clear backbone, label transit_or_isp
    if (/isp|telecom|communications|network/i.test(blob) && !infraHints.test(blob)) {
      return { classification: "transit_or_isp", reasons };
    }
    return { classification: "infrastructure", reasons };
  }
  return {
    classification: "transit_or_isp",
    reasons: [...reasons, "mixed customer/infra signals"],
  };
}

type BgpViewIpResponse = {
  status?: string;
  data?: {
    ip?: string;
    ptr_record?: string;
    prefixes?: Array<{
      prefix?: string;
      ip?: string;
      cidr?: number;
      asn?: {
        asn?: number;
        name?: string;
        description?: string;
        country_code?: string;
      };
      name?: string;
      description?: string;
      country_code?: string;
    }>;
    rir_allocation?: {
      rir_name?: string;
      country_code?: string;
      date_allocated?: string;
      allocation?: string;
    };
  };
};

export function summarizeBgpView(ip: string, body: BgpViewIpResponse) {
  const prefixes = body.data?.prefixes ?? [];
  const primary = prefixes[0];
  const asn = primary?.asn;
  const prefixStr =
    primary?.prefix ??
    (primary?.ip && primary?.cidr != null ? `${primary.ip}/${primary.cidr}` : undefined);
  const prefixLen = primary?.cidr ?? prefixLengthFromCidr(prefixStr);

  const usage = classifyBgpUsage({
    prefix: prefixStr,
    prefixLen,
    asnName: asn?.name,
    asnDescription: asn?.description,
    prefixName: primary?.name,
    prefixDescription: primary?.description,
  });

  return {
    ip,
    ptr: body.data?.ptr_record,
    asn: asn?.asn != null ? `AS${asn.asn}` : undefined,
    asnNumber: asn?.asn,
    asnName: asn?.name,
    asnDescription: asn?.description,
    asnCountry: asn?.country_code,
    prefix: prefixStr,
    prefixLen,
    prefixName: primary?.name,
    prefixDescription: primary?.description,
    prefixCountry: primary?.country_code,
    rir: body.data?.rir_allocation?.rir_name,
    rirAllocation: body.data?.rir_allocation?.allocation,
    rirCountry: body.data?.rir_allocation?.country_code,
    prefixes: prefixes.slice(0, 12).map((p) => ({
      prefix: p.prefix ?? (p.ip && p.cidr != null ? `${p.ip}/${p.cidr}` : undefined),
      asn: p.asn?.asn != null ? `AS${p.asn.asn}` : undefined,
      name: p.name ?? p.asn?.name,
      description: p.description ?? p.asn?.description,
      country: p.country_code ?? p.asn?.country_code,
    })),
    classification: usage.classification,
    classificationReasons: usage.reasons,
    hint:
      usage.classification === "customer_access"
        ? "更像接入网/客户地址池；网络所有者≠终端使用机构"
        : usage.classification === "infrastructure"
          ? "更像基础设施/骨干/托管；可偏向 org_is_infra_provider"
          : usage.classification === "transit_or_isp"
            ? "ISP/聚合段信号；慎下 org_uses_ip，优先 network_owner"
            : "BGP 信号不足，需结合 PTR/被动DNS/HTTP",
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "bgp_lookup",
    label: "BGP Lookup",
    description:
      "查询 IP 的 BGP 前缀/ASN（BGPView），并启发式区分 customer_access vs infrastructure，辅助研判接入网与基础设施。",
    parameters: Type.Object({
      ip: Type.Optional(Type.String({ description: "IPv4" })),
      target: Type.Optional(Type.String({ description: "IPv4 或含 IP 的 URL" })),
      input: Type.Optional(Type.String({ description: "IPv4 或含 IP 的 URL" })),
      raw: Type.Optional(Type.Boolean({ description: "返回 BGPView 原始 JSON" })),
      timeout_seconds: Type.Optional(Type.Number({ description: "超时秒数，默认 20" })),
    }),
    async execute(_id, params, signal) {
      const rawInput = params.ip ?? params.target ?? params.input;
      if (!rawInput?.trim()) {
        return {
          content: [{ type: "text", text: "缺少 ip / target / input" }],
          details: {},
          isError: true,
        };
      }

      let ip: string;
      try {
        ip = resolveIp(rawInput);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          details: {},
          isError: true,
        };
      }

      const timeoutMs = Math.max(3, params.timeout_seconds ?? 20) * 1000;
      const url = `https://api.bgpview.io/ip/${encodeURIComponent(ip)}`;
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort);
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { Accept: "application/json", "User-Agent": "pi-web-bgp-lookup/0.1" },
        });
        if (!res.ok) {
          const err = {
            error: true,
            message: `BGPView HTTP ${res.status}`,
            ip,
            url,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(err, null, 2) }],
            details: err,
            isError: true,
          };
        }
        const data = (await res.json()) as BgpViewIpResponse;
        if (params.raw === true) {
          const payload = { ip, url, mode: "raw", bgpview: data };
          return {
            content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
            details: payload,
          };
        }
        const summary = {
          target: rawInput.trim(),
          url,
          mode: "summary",
          provider: "bgpview",
          ...summarizeBgpView(ip, data),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
          details: summary,
        };
      } catch (error) {
        const aborted = signal?.aborted;
        const message =
          aborted || (error instanceof Error && error.name === "AbortError")
            ? `timeout/${timeoutMs}ms`
            : error instanceof Error
              ? error.message
              : String(error);
        const err = { error: true, message, ip, url };
        return {
          content: [{ type: "text", text: JSON.stringify(err, null, 2) }],
          details: err,
          isError: true,
        };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  });
}
