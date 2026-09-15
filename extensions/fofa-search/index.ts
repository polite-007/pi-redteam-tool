/**
 * FOFA Search extension for Pi Coding Agent.
 *
 * Config loading and asset/query helpers live in `_shared/` — see
 * `_shared/fofa-config.ts` (priority: REDTEAM_FOFA_* env > settings.json) and
 * `_shared/fofa-asset.ts`. `resolveAsset` and `buildDefaultQuery` keep the
 * exports they already had; `loadFofaConfig` is additionally re-exported — it
 * used to be module-private, and the test suite needs it to pin config
 * behaviour.
 *
 * Default return fields = official common set (34). Heavy: header/banner/cert.
 * Official list: https://fofa.info/api
 *
 * ## Query grammar (qbase64) examples
 * ip= / domain= / host= / port= / protocol= / title= / server= / banner=
 * country= / region= / city= / asn= / org= / icp= / cert= / cert.subject= / product=
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  fofaNotConfiguredError,
  loadFofaConfig,
  type FofaConfig,
} from "../../_shared/fofa-config.ts";
import {
  buildDefaultQuery,
  parseAsset,
  type ResolvedAsset,
} from "../../_shared/fofa-asset.ts";

export { loadFofaConfig } from "../../_shared/fofa-config.ts";
export { buildDefaultQuery } from "../../_shared/fofa-asset.ts";

/**
 * Official FOFA common return fields (default).
 * Order matches FOFA API docs.
 */
export const FOFA_FIELDS_DEFAULT = [
  "ip",
  "port",
  "protocol",
  "country",
  "country_name",
  "region",
  "city",
  "longitude",
  "latitude",
  "asn",
  "org",
  "host",
  "domain",
  "os",
  "server",
  "icp",
  "title",
  "jarm",
  "header",
  "banner",
  "cert",
  "base_protocol",
  "link",
  "cert.issuer.org",
  "cert.issuer.cn",
  "cert.subject.org",
  "cert.subject.cn",
  "tls.ja3s",
  "tls.version",
  "cert.sn",
  "cert.not_before",
  "cert.not_after",
  "cert.domain",
  "status_code",
].join(",");

/** Lighter set without header/banner/raw cert (saves F-points). */
export const FOFA_FIELDS_LIGHT = [
  "ip",
  "port",
  "protocol",
  "country",
  "country_name",
  "region",
  "city",
  "longitude",
  "latitude",
  "asn",
  "org",
  "host",
  "domain",
  "os",
  "server",
  "icp",
  "title",
  "jarm",
  "base_protocol",
  "link",
  "cert.issuer.org",
  "cert.issuer.cn",
  "cert.subject.org",
  "cert.subject.cn",
  "tls.ja3s",
  "tls.version",
  "cert.sn",
  "cert.not_before",
  "cert.not_after",
  "cert.domain",
  "status_code",
].join(",");

const FIELD_PRESETS: Record<string, string> = {
  default: FOFA_FIELDS_DEFAULT,
  full: FOFA_FIELDS_DEFAULT,
  light: FOFA_FIELDS_LIGHT,
  /** @deprecated alias → default */
  asset: FOFA_FIELDS_DEFAULT,
  /** @deprecated alias → light */
  minimal: FOFA_FIELDS_LIGHT,
  /** @deprecated alias → default */
  rich: FOFA_FIELDS_DEFAULT,
};

interface FofaSearchResult {
  error?: boolean;
  errmsg?: string;
  size?: number;
  page?: number;
  query?: string;
  results?: string[][];
  fields?: string;
}

/**
 * Classify and normalise a user-supplied asset, with this tool's own error
 * wording. The parsing logic itself lives in `_shared/fofa-asset.ts`.
 */
export function resolveAsset(input: string): ResolvedAsset {
  const raw = input.trim();
  if (!raw) throw new Error("资产输入为空");
  const asset = parseAsset(raw);
  if (!asset) throw new Error(`无法解析资产: ${raw}`);
  return asset;
}

const CERT_STRIP_RE =
  /(?:Signature Algorithm|Certificate Signature|SHA1 Fingerprint|SHA-256 Fingerprint|TLS Version|Cipher Suite|Timestamp)[^\n]*(?:\n\s+[0-9A-Fa-f:]+)*/gi;

function truncateText(value: string, max: number): string {
  const t = value.replace(/\n{2,}/g, "\n").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function stripCertField(cert: string): string {
  return truncateText(cert.replace(CERT_STRIP_RE, ""), 600);
}

export function resolveFields(params: {
  fields?: string;
  preset?: string;
}): string {
  if (typeof params.fields === "string" && params.fields.trim()) {
    return params.fields
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean)
      .join(",");
  }
  const preset = (params.preset ?? "default").toLowerCase();
  return FIELD_PRESETS[preset] ?? FOFA_FIELDS_DEFAULT;
}

export function capSize(fields: string, requested?: number): number {
  const size = Math.max(1, Math.min(requested ?? 20, 100));
  const heavy = /\b(banner|header|body|cert)\b/.test(fields);
  if (/\bbody\b/.test(fields)) return Math.min(size, 20);
  if (heavy) return Math.min(size, 50);
  return size;
}

export function rowsToObjects(
  fieldsCsv: string,
  rows: string[][] | undefined
): Array<Record<string, string>> {
  const fields = fieldsCsv.split(",").map((f) => f.trim());
  if (!rows?.length) return [];
  return rows.map((row) => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < fields.length; i++) {
      const name = fields[i]!;
      let val = row[i] ?? "";
      if (name === "cert" || name.startsWith("cert.")) {
        val = stripCertField(val);
      } else if (name === "banner" || name === "header" || name === "body") {
        val = truncateText(val, 400);
      }
      obj[name] = val;
    }
    return obj;
  });
}

async function fofaSearch(
  cfg: FofaConfig,
  query: string,
  options: {
    page?: number;
    size?: number;
    fields: string;
    signal?: AbortSignal;
  }
): Promise<FofaSearchResult> {
  const base = cfg.baseUrl.endsWith("/") ? cfg.baseUrl : `${cfg.baseUrl}/`;
  const url = new URL("api/v1/search/all", base);
  url.searchParams.set("qbase64", Buffer.from(query, "utf8").toString("base64"));
  url.searchParams.set("page", String(options.page ?? 1));
  url.searchParams.set("size", String(capSize(options.fields, options.size)));
  url.searchParams.set("fields", options.fields);
  url.searchParams.set("key", cfg.key);
  if (cfg.email) url.searchParams.set("email", cfg.email);

  const res = await fetch(url, { signal: options.signal });
  if (!res.ok) {
    throw new Error(`FOFA HTTP ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as FofaSearchResult;
  // Echo fields we requested so callers can map rows even if API omits it
  data.fields = data.fields || options.fields;
  return data;
}

export function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "fofa_search",
    label: "FOFA Search",
    description:
      "通过 FOFA API 查询网络空间资产。默认返回官方常见 34 字段（含 asn/geo/cert/banner/header）。可用 fields 自定义，或 preset=default|light。",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "FOFA 查询语法" })),
      target: Type.Optional(Type.String({ description: "IP、域名或 URL" })),
      input: Type.Optional(Type.String({ description: "IP、域名或 URL" })),
      page: Type.Optional(Type.Number({ description: "页码，默认 1" })),
      size: Type.Optional(
        Type.Number({
          description: "每页条数，默认 20（含 banner/header/cert 时自动下调上限）",
        })
      ),
      fields: Type.Optional(
        Type.String({
          description: "逗号分隔返回字段；省略则用 preset/default 34 字段",
        })
      ),
      preset: Type.Optional(
        Type.String({
          description: "字段预设: default(官方34字段) | light(去掉 header/banner/cert 原文)",
        })
      ),
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

      let query = params.query?.trim();
      if (!query) {
        const raw = params.target ?? params.input;
        if (!raw) {
          return {
            content: [{ type: "text", text: "缺少 query 或 target/input 参数" }],
            details: {},
            isError: true,
          };
        }
        query = buildDefaultQuery(resolveAsset(raw));
      }

      const fields = resolveFields({
        fields: params.fields,
        preset: params.preset,
      });

      try {
        const data = await fofaSearch(cfg, query, {
          page: params.page,
          size: params.size,
          fields,
          signal,
        });

        if (data.error) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: true, errmsg: data.errmsg, query, fields }, null, 2),
              },
            ],
            details: { query, fields, raw: data },
            isError: true,
          };
        }

        const items = rowsToObjects(fields, data.results);
        const payload = {
          query,
          fields,
          page: data.page,
          size: data.size,
          totalHint: data.size,
          count: items.length,
          results: items,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          details: payload,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: true, message, query, fields }, null, 2) },
          ],
          details: { query, fields },
          isError: true,
        };
      }
    },
  });
}
