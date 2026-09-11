/**
 * Passive DNS extension for Pi Coding Agent.
 * Passive DNS via crt.sh + SecurityTrails.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

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
    throw new Error("passive_dns 暂仅支持 IPv4 IP 或域名（IPv6 请用域名路径）");
  }
  return { target: host.toLowerCase(), kind: "domain" };
}

export function loadSecurityTrailsKey(): string | undefined {
  // Environment variable (highest priority)
  const envKey = process.env.REDTEAM_PASSIVE_DNS_KEY?.trim();
  if (envKey) return envKey;

  // settings.json: look for ~/.pi/agent/settings.json or PI_SETTINGS_PATH
  const settingsPath = process.env.PI_SETTINGS_PATH || join(homedir(), ".pi", "agent", "settings.json");
  try {
    if (existsSync(settingsPath)) {
      const content = readFileSync(settingsPath, "utf8");
      const settings = JSON.parse(content);
      const key = settings?.redteam?.passiveDns?.securityTrailsKey;
      if (typeof key === "string" && key.trim()) {
        return key.trim();
      }
    }
  } catch {
    // Ignore errors reading settings.json
  }

  return undefined;
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
      headers: { Accept: "application/json", "User-Agent": "pi-web-passive-dns/0.1" },
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
      headers: { "User-Agent": "pi-web-passive-dns/0.1" },
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
        "User-Agent": "pi-web-passive-dns/0.1",
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

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "passive_dns",
    label: "Passive DNS",
    description:
      "被动 DNS / 证书透明度：域名查 crt.sh；IP 查历史关联域名（有 Key 用 SecurityTrails，否则 HackerTarget 尽力）。用于 IP↔域名 历史关联。",
    parameters: Type.Object({
      target: Type.Optional(Type.String({ description: "IP、域名或 URL" })),
      input: Type.Optional(Type.String({ description: "IP、域名或 URL" })),
      timeout_seconds: Type.Optional(Type.Number({ description: "超时秒数，默认 25" })),
      limit: Type.Optional(Type.Number({ description: "返回域名上限，默认 100" })),
    }),
    async execute(_id, params, signal, _onUpdate, _ctx) {
      const raw = params.target ?? params.input;
      if (!raw?.trim()) {
        return {
          content: [{ type: "text", text: "缺少 target 或 input 参数" }],
          details: {},
          isError: true,
        };
      }

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
    },
  });
}
