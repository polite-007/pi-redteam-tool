/**
 * GreyNoise Lookup extension for Pi Coding Agent.
 * Threat intelligence via GreyNoise API.
 *
 * - With API key: prefer GET /v3/ip/{ip} (unified scanner + RIOT context; fields depend on plan)
 * - Without key / on auth fail: GET /v3/community/{ip} (noise/riot/classification)
 *
 * Config: REDTEAM_GREYNOISE_KEY env (pi-redteam-tool injects config/config.yaml greynoise.key).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const IPV4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

function loadGreynoiseKey(): string | null {
  return process.env.REDTEAM_GREYNOISE_KEY?.trim() || null;
}

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
  if (!raw) throw new Error("缺少 target 或 input");
  if (IPV4.test(raw)) return raw;
  try {
    const withScheme = raw.includes("://") ? raw : `https://${raw}`;
    const host = stripPort(new URL(withScheme).hostname);
    if (IPV4.test(host)) return host;
  } catch {
    /* fall through */
  }
  throw new Error(`greynoise_lookup 需要 IPv4，收到: ${raw}`);
}

/** Pick research-useful fields; keep unknowns via ...rest when raw. */
export function summarizeIpLookup(body: Record<string, unknown>, ip: string) {
  return {
    ip: body.ip ?? ip,
    seen: body.seen,
    noise: body.noise ?? body.internet_scanner_intelligence,
    riot: body.riot ?? body.business_service_intelligence,
    classification: body.classification,
    name: body.name,
    link: body.link ?? body.viz_link ?? body.permalink,
    last_seen: body.last_seen,
    first_seen: body.first_seen,
    actor: body.actor,
    tags: body.tags,
    spoofable: body.spoofable,
    bot: body.bot,
    vpn: body.vpn,
    tor: body.tor,
    metadata: body.metadata,
    asn: body.asn ?? (body.metadata as { asn?: string } | undefined)?.asn,
    org: body.organization ?? (body.metadata as { organization?: string } | undefined)?.organization,
    rdns: body.rdns ?? (body.metadata as { rDNS?: string } | undefined)?.rDNS,
    city: body.city ?? (body.metadata as { city?: string } | undefined)?.city,
    country: body.country ?? (body.metadata as { country?: string } | undefined)?.country,
    category: body.category,
    trust_level: body.trust_level,
    message: body.message,
  };
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, { headers, signal });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text.slice(0, 800) };
  }
  return { status: res.status, body };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "greynoise_lookup",
    label: "GreyNoise Lookup",
    description:
      "查询 GreyNoise：噪声/扫描器/RIOT/分类。有 Key 优先 /v3/ip（上下文更全）；无 Key 用 Community。raw=true 返回完整 JSON。",
    parameters: Type.Object({
      target: Type.Optional(Type.String({ description: "IPv4" })),
      input: Type.Optional(Type.String({ description: "IPv4 或含 IP 的 URL" })),
      ip: Type.Optional(Type.String({ description: "IPv4" })),
      quick: Type.Optional(
        Type.Boolean({ description: "true 时 /v3/ip?quick=true 轻量响应（需 Key）" })
      ),
      raw: Type.Optional(
        Type.Boolean({ description: "true 返回完整 API JSON，默认摘要" })
      ),
      force_community: Type.Optional(
        Type.Boolean({ description: "强制只用 Community 接口" })
      ),
      timeout_seconds: Type.Optional(Type.Number({ description: "超时秒数，默认 20" })),
    }),
    async execute(_id, params, signal, _onUpdate, _ctx) {
      const raw = params.ip ?? params.target ?? params.input;
      if (!raw?.trim()) {
        return {
          content: [{ type: "text", text: "缺少 ip / target / input 参数" }],
          details: {},
          isError: true,
        };
      }

      let ip: string;
      try {
        ip = resolveIp(raw);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          details: {},
          isError: true,
        };
      }

      const apiKey = loadGreynoiseKey();
      const timeoutMs = Math.max(3, params.timeout_seconds ?? 20) * 1000;
      const headers: Record<string, string> = {
        Accept: "application/json",
        "User-Agent": "pi-redteam-tool-asset-judge",
      };
      if (apiKey) headers.key = apiKey;

      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort);
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const wantRaw = params.raw === true;
      const forceCommunity = params.force_community === true || !apiKey;

      try {
        let endpoint = "community";
        let status = 0;
        let body: Record<string, unknown> = {};

        if (!forceCommunity) {
          const q = params.quick === true ? "?quick=true" : "";
          const url = `https://api.greynoise.io/v3/ip/${encodeURIComponent(ip)}${q}`;
          const r = await fetchJson(url, headers, controller.signal);
          status = r.status;
          body = r.body;
          endpoint = params.quick === true ? "v3/ip?quick" : "v3/ip";

          // Paid endpoint rejected → fall back to community
          if (status === 401 || status === 403 || status === 402) {
            const communityUrl = `https://api.greynoise.io/v3/community/${encodeURIComponent(ip)}`;
            const c = await fetchJson(communityUrl, headers, controller.signal);
            status = c.status;
            body = c.body;
            endpoint = "community(fallback)";
          }
        } else {
          const communityUrl = `https://api.greynoise.io/v3/community/${encodeURIComponent(ip)}`;
          const c = await fetchJson(communityUrl, headers, controller.signal);
          status = c.status;
          body = c.body;
          endpoint = "community";
        }

        if (status === 401 || status === 403) {
          const err = {
            error: "GREYNOISE_AUTH",
            message:
              "GreyNoise 鉴权失败。请配置 REDTEAM_GREYNOISE_KEY 或 config/config.yaml 的 greynoise.key。",
            status,
            ip,
            hasKey: !!apiKey,
            endpoint,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(err, null, 2) }],
            details: err,
            isError: true,
          };
        }

        if (status === 429) {
          const err = {
            error: "GREYNOISE_RATE_LIMIT",
            message: "GreyNoise 限流（Community 有日/周配额）。稍后重试或升级套餐。",
            status,
            ip,
            endpoint,
            body,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(err, null, 2) }],
            details: err,
            isError: true,
          };
        }

        if (status === 404) {
          const payload = {
            ip,
            endpoint,
            message:
              (body.message as string) ||
              "IP not observed by GreyNoise (not in noise/RIOT datasets)",
            noise: false,
            riot: false,
            classification: "unknown",
            configuredKey: !!apiKey,
            ...(wantRaw ? { raw: body } : {}),
          };
          return {
            content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
            details: payload,
          };
        }

        if (status < 200 || status >= 300) {
          const err = {
            error: true,
            status,
            message: `GreyNoise HTTP ${status}`,
            ip,
            endpoint,
            body,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(err, null, 2) }],
            details: err,
            isError: true,
          };
        }

        const payload = wantRaw
          ? { ip, endpoint, configuredKey: !!apiKey, mode: "raw", data: body }
          : {
              ...summarizeIpLookup(body, ip),
              endpoint,
              configuredKey: !!apiKey,
              mode: "summary",
            };

        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          details: payload,
        };
      } catch (error) {
        const aborted = controller.signal.aborted;
        const message = aborted
          ? `GreyNoise 超时或取消（${timeoutMs}ms）`
          : error instanceof Error
            ? error.message
            : String(error);
        const err = { error: true, message, ip };
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
