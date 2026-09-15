/**
 * fofa_stats — FOFA 统计聚合（aggregation）extension for Pi Coding Agent.
 *
 * Endpoint: `GET /api/v1/search/stats?key=&qbase64=&fields=&size=`
 *
 * This is a *different* FOFA API from the one `fofa_search` calls. Key
 * differences that shape this code:
 *
 *   - `qbase64` is **required**. There is no "aggregate everything" call; a
 *     query always comes from `query` or from `target`/`input`.
 *   - The response has **no `results`** array. It is
 *     `{error, errmsg?, size, distinct, aggs, lastupdatetime,
 *       consumed_fpoint, required_fpoints}`.
 *   - ⚠️ The response's `size` is the **total match count**, while the request's
 *     `size` is the **per-field TOP N**. Same word, two meanings, in one
 *     request/response pair. This tool therefore calls the request-side value
 *     `top` and renames the response-side one to `total` on the way out.
 *   - ⚠️ `aggs` keys do **not** always equal the requested field names:
 *     `fields=country` comes back under the key `countries`. We surface
 *     `agg_keys` so the caller can see this instead of guessing.
 *   - Requires FOFA 专业版 or above, and is rate limited to 1 request / 5s.
 *
 * Config loading and asset/query helpers are shared with the other FOFA
 * extensions via `_shared/`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fofaNotConfiguredError, loadFofaConfig } from "../../_shared/fofa-config.ts";
import { buildDefaultQuery, parseAsset } from "../../_shared/fofa-asset.ts";

/**
 * The official aggregation whitelist (FOFA docs, 附录2 — Statistic
 * aggregation interface support fields). Sending anything outside this list
 * is rejected locally rather than burning a rate-limited API call.
 *
 * Note there is no standalone `region`/`city`/`cert` dimension: `country`
 * covers country *and* city, and returns provinces/cities nested under each
 * item's `regions` array.
 */
export const STATS_AGG_FIELDS = [
  "protocol",
  "domain",
  "port",
  "title",
  "os",
  "server",
  "country",
  "asn",
  "org",
  "asset_type",
  "fid",
  "icp",
] as const;

/** Aggregation applied when the caller does not choose any. */
export const DEFAULT_STATS_FIELDS = ["protocol", "port", "country"];

/** TOP-N per field when the caller does not choose. Matches the FOFA default. */
export const DEFAULT_TOP = 5;

/**
 * Upper bound on `top`. FOFA does not document a maximum, so this is our own
 * ceiling — chosen to match `fofa_search`'s 100-result page cap, and to keep
 * aggregation payloads (which may include long HTTP titles) from ballooning.
 */
export const MAX_TOP = 100;

const DEFAULT_TIMEOUT_SECONDS = 20;

interface FofaStatsResponse {
  error?: boolean;
  errmsg?: string;
  /** Total number of matching assets — NOT the aggregation depth. */
  size?: number;
  distinct?: Record<string, number>;
  aggs?: Record<string, unknown[]>;
  lastupdatetime?: string;
  consumed_fpoint?: number;
  required_fpoints?: number;
}

/**
 * Parse and validate the `fields` parameter.
 *
 * Three distinct states, deliberately:
 *   - `undefined`            → the default aggregation set
 *   - `""` / whitespace-only → NO aggregation: a total-only query. `fields` is
 *                              optional to FOFA, so omitting it is legal and
 *                              much cheaper than aggregating.
 *   - a comma-separated list → validated against the official whitelist
 */
export function resolveStatsFields(input: string | undefined): string[] {
  if (input === undefined) return [...DEFAULT_STATS_FIELDS];
  if (!input.trim()) return [];

  const requested = input
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);

  const unknown = requested.filter(
    (f) => !(STATS_AGG_FIELDS as readonly string[]).includes(f),
  );
  if (unknown.length) {
    throw new Error(
      `无法聚合的字段: ${unknown.join(", ")}。统计聚合仅支持: ${STATS_AGG_FIELDS.join(", ")}`,
    );
  }
  // De-duplicate while preserving the caller's order.
  return [...new Set(requested)];
}

/** Clamp `top` into [1, MAX_TOP], defaulting to DEFAULT_TOP. */
export function clampTop(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_TOP;
  return Math.max(1, Math.min(Math.floor(requested), MAX_TOP));
}

/** Seconds to wait before giving up, floored at 5 (mirrors fofa_host). */
export function clampTimeoutSeconds(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return DEFAULT_TIMEOUT_SECONDS;
  }
  return Math.max(5, Math.floor(requested));
}

/**
 * Reshape a raw FOFA stats response into the payload handed to the model.
 *
 * The rename that matters: response `size` → `total`. Leaving it as `size`
 * would collide with the request-side `size`/`top` concept and invites the
 * model to read the total match count as "the aggregation depth".
 */
export function normalizeStats(
  body: FofaStatsResponse,
  request: { query: string; fields: string[]; top: number },
): Record<string, unknown> {
  const aggs = body.aggs ?? {};
  const payload: Record<string, unknown> = {
    query: request.query,
    fields: request.fields,
    top: request.top,
    total: body.size,
    agg_keys: Object.keys(aggs),
    distinct: body.distinct ?? {},
    aggs,
  };
  if (body.lastupdatetime) payload.lastupdatetime = body.lastupdatetime;
  if (body.consumed_fpoint !== undefined) payload.consumed_fpoint = body.consumed_fpoint;
  if (body.required_fpoints !== undefined) payload.required_fpoints = body.required_fpoints;
  return payload;
}

/** Build the aggregated query from `query`, or from a `target`/`input` asset. */
export function resolveStatsQuery(params: {
  query?: string;
  target?: string;
  input?: string;
}): string {
  const query = params.query?.trim();
  if (query) return query;

  const raw = (params.target ?? params.input)?.trim();
  if (!raw) {
    throw new Error("缺少 query 或 target/input 参数");
  }
  const asset = parseAsset(raw);
  if (!asset) throw new Error(`无法解析资产: ${raw}`);
  return buildDefaultQuery(asset);
}

/**
 * A hint attached to any API-reported failure. The stats endpoint is gated
 * behind a membership tier (this is official — it is listed on FOFA's pricing
 * page) and is rate limited far more tightly than the search endpoint, so
 * those two causes are worth naming up front.
 */
const FAILURE_HINT =
  "统计聚合接口需要 FOFA 专业版及以上会员，且官方限速为 5 秒/次。若刚调用过请稍后重试。";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "fofa_stats",
    label: "FOFA Stats",
    description:
      "FOFA 统计聚合：判断某个查询或目标的资产规模与分布（总量、按协议/端口/国家/ASN/标题等的 TOP 排名）时用这个。" +
      "需要具体资产明细列表时请改用 fofa_search。默认聚合 protocol,port,country 各取 TOP 5。" +
      "该接口需要 FOFA 专业版及以上会员，限速 5 秒/次。",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "FOFA 查询语法" })),
      target: Type.Optional(Type.String({ description: "IP、域名或 URL，自动构建默认查询" })),
      input: Type.Optional(Type.String({ description: "同 target" })),
      fields: Type.Optional(
        Type.String({
          description:
            `逗号分隔的聚合字段，可选: ${STATS_AGG_FIELDS.join(", ")}。` +
            `省略则聚合 ${DEFAULT_STATS_FIELDS.join(",")}；传空字符串则只统计总量、不做聚合。`,
        }),
      ),
      top: Type.Optional(
        Type.Number({
          description: `每个聚合字段返回前 N 个值，默认 ${DEFAULT_TOP}，上限 ${MAX_TOP}（对应 FOFA 参数的 size）`,
        }),
      ),
      timeout_seconds: Type.Optional(Type.Number({ description: "超时秒数，默认 20" })),
    }),
    async execute(_id, params, signal, _onUpdate, _ctx) {
      // An already-aborted signal means the caller cancelled before we ran.
      // `addEventListener("abort", …)` below would never fire for it, so the
      // request would go out anyway — check up front.
      if (signal?.aborted) {
        const err = { error: true, message: "fofa_stats: 已取消（调用方在调用前已中止）" };
        return {
          content: [{ type: "text", text: JSON.stringify(err, null, 2) }],
          details: err,
          isError: true,
        };
      }

      const cfg = loadFofaConfig();
      if (!cfg?.key) {
        const err = fofaNotConfiguredError();
        return {
          content: [{ type: "text", text: JSON.stringify(err, null, 2) }],
          details: { configured: false },
          isError: true,
        };
      }

      let query: string;
      let fields: string[];
      try {
        query = resolveStatsQuery(params);
        fields = resolveStatsFields(params.fields);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          details: {},
          isError: true,
        };
      }

      const top = clampTop(params.top);
      const timeoutMs = clampTimeoutSeconds(params.timeout_seconds) * 1000;
      const base = cfg.baseUrl.endsWith("/") ? cfg.baseUrl : `${cfg.baseUrl}/`;
      const url = new URL("api/v1/search/stats", base);
      url.searchParams.set("qbase64", Buffer.from(query, "utf8").toString("base64"));
      url.searchParams.set("size", String(top));
      // `fields` is optional to FOFA — omitting it asks for the total only.
      if (fields.length) url.searchParams.set("fields", fields.join(","));
      url.searchParams.set("key", cfg.key);
      if (cfg.email) url.searchParams.set("email", cfg.email);

      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort);
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(url.toString(), { signal: controller.signal });
        const text = await res.text();
        let body: FofaStatsResponse;
        try {
          body = JSON.parse(text) as FofaStatsResponse;
        } catch {
          body = { error: true, errmsg: text.slice(0, 800) };
        }

        if (!res.ok) {
          const err = {
            error: true,
            status: res.status,
            message: `FOFA stats HTTP ${res.status}`,
            query,
            hint: FAILURE_HINT,
            body,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(err, null, 2) }],
            details: err,
            isError: true,
          };
        }

        if (body.error === true) {
          const err = {
            error: true,
            // FOFA formats this as "[-700] 账号无效".
            errmsg: body.errmsg ?? (body as { message?: string }).message,
            query,
            hint: FAILURE_HINT,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(err, null, 2) }],
            details: { query, raw: body },
            isError: true,
          };
        }

        const payload = normalizeStats(body, { query, fields, top });
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          details: payload,
        };
      } catch (error) {
        // Distinguish a caller cancellation from our own timeout — reporting a
        // deliberate cancel as "timed out after 20000ms" is just wrong.
        const message = signal?.aborted
          ? "fofa_stats: 已取消（调用方中止了请求）"
          : controller.signal.aborted
            ? `FOFA stats 超时（${timeoutMs}ms）；该接口官方限速 5 秒/次`
            : error instanceof Error
              ? error.message
              : String(error);
        const err = { error: true, message, query, fields };
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
