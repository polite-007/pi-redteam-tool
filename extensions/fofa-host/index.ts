/**
 * FOFA Host extension for Pi Coding Agent.
 *
 * Config loading and host normalisation live in `_shared/` — see
 * `_shared/fofa-config.ts` (priority: REDTEAM_FOFA_* env > settings.json) and
 * `_shared/fofa-asset.ts`. `resolveHost` keeps the export it already had;
 * `loadFofaConfig` is additionally re-exported — it used to be module-private,
 * and the test suite needs it to pin config behaviour.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fofaNotConfiguredError, loadFofaConfig } from "../../_shared/fofa-config.ts";
import { parseAsset } from "../../_shared/fofa-asset.ts";

export { loadFofaConfig } from "../../_shared/fofa-config.ts";

/**
 * Reduce any user input (IP, domain, URL) to a bare host, with this tool's
 * own error wording. The parsing logic itself lives in
 * `_shared/fofa-asset.ts`.
 */
export function resolveHost(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error("缺少 host / target / input");
  const asset = parseAsset(raw);
  if (!asset) throw new Error(`无法解析 host: ${raw}`);
  return asset.host;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "fofa_host",
    label: "FOFA Host",
    description:
      "FOFA Host 聚合：按 IP/host 返回 asn/org/geo、端口、协议、产品分类与标签。限制约 1 次/秒；detail=true 可看端口详情。",
    parameters: Type.Object({
      host: Type.Optional(Type.String({ description: "IP 或 host（通常是 IP）" })),
      target: Type.Optional(Type.String({ description: "IP、域名或 URL（取 host）" })),
      input: Type.Optional(Type.String({ description: "IP、域名或 URL（取 host）" })),
      detail: Type.Optional(
        Type.Boolean({ description: "是否返回端口详情，默认 false" })
      ),
      timeout_seconds: Type.Optional(Type.Number({ description: "超时秒数，默认 20" })),
    }),
    async execute(_id, params, signal, _onUpdate, _ctx) {
      const cfg = loadFofaConfig();
      if (!cfg?.key) {
        const err = fofaNotConfiguredError();
        return {
          content: [{ type: "text", text: JSON.stringify(err, null, 2) }],
          details: { configured: false },
          isError: true,
        };
      }

      const raw = params.host ?? params.target ?? params.input;
      if (!raw?.trim()) {
        return {
          content: [{ type: "text", text: "缺少 host / target / input 参数" }],
          details: {},
          isError: true,
        };
      }

      let host: string;
      try {
        host = resolveHost(raw);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          details: {},
          isError: true,
        };
      }

      const detail = params.detail === true;
      const timeoutMs = Math.max(5, params.timeout_seconds ?? 20) * 1000;
      const base = cfg.baseUrl.endsWith("/") ? cfg.baseUrl : `${cfg.baseUrl}/`;
      const url = new URL(`api/v1/host/${encodeURIComponent(host)}`, base);
      url.searchParams.set("detail", detail ? "true" : "false");
      url.searchParams.set("key", cfg.key);
      if (cfg.email) url.searchParams.set("email", cfg.email);

      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort);
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(url.toString(), { signal: controller.signal });
        const text = await res.text();
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(text) as Record<string, unknown>;
        } catch {
          body = { raw: text.slice(0, 800) };
        }

        if (!res.ok) {
          const err = {
            error: true,
            status: res.status,
            message: `FOFA host HTTP ${res.status}`,
            host,
            body,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(err, null, 2) }],
            details: err,
            isError: true,
          };
        }

        if (body.error === true) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    error: true,
                    errmsg: body.errmsg ?? body.message,
                    host,
                    detail,
                  },
                  null,
                  2
                ),
              },
            ],
            details: { host, detail, raw: body },
            isError: true,
          };
        }

        // Keep API payload; add request echo for the model
        const payload = {
          requestedHost: host,
          detail,
          ...body,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          details: payload,
        };
      } catch (error) {
        const aborted = controller.signal.aborted;
        const message = aborted
          ? `FOFA host 超时或取消（${timeoutMs}ms）；注意接口约 1 次/秒`
          : error instanceof Error
            ? error.message
            : String(error);
        const err = { error: true, message, host, detail };
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
