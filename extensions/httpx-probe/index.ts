/**
 * HTTPX Probe extension for Pi Coding Agent.
 * HTTP probe with ProjectDiscovery httpx.
 *
 * Profile A defaults: title/status/length/type/location/server/ip/cname/asn/cdn/
 * tech/tls/favicon/rt + follow redirects + chain + response headers + body preview.
 */
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const DEFAULT_UA = "pi-redteam-tool-httpx-probe/0.3";
const DEFAULT_MAX_REDIRECTS = 10;
const DEFAULT_BODY_PREVIEW = 4096;
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

export type HttpxRunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

export type HttpxRunner = (
  binary: string,
  args: string[],
  signal?: AbortSignal
) => Promise<HttpxRunResult>;

let httpxRunner: HttpxRunner = defaultHttpxRunner;

/** Test hook: inject CLI runner. Pass null to restore default. */
export function setHttpxRunnerForTests(runner: HttpxRunner | null): void {
  httpxRunner = runner ?? defaultHttpxRunner;
}

export function defaultHttpxRunner(
  binary: string,
  args: string[],
  signal?: AbortSignal
): Promise<HttpxRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      // ProjectDiscovery httpx also consumes stdin. Leaving Node's default
      // pipe open makes a target-mode invocation wait indefinitely for EOF.
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr?.on("data", (c: string) => {
      stderr += c;
    });
    child.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr });
    });
  });
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

export function buildUrls(
  input: string,
  scheme?: string
): { host: string; urls: string[] } {
  const raw = input.trim();
  if (!raw) throw new Error("缺少 target 或 input");

  if (/^https?:\/\//i.test(raw)) {
    const u = new URL(raw);
    return { host: stripPort(u.hostname), urls: [raw] };
  }

  const host = stripPort(raw.includes("/") ? raw.split("/")[0]! : raw);
  if (scheme === "http") return { host, urls: [`http://${host}/`] };
  if (scheme === "https") return { host, urls: [`https://${host}/`] };
  return { host, urls: [`https://${host}/`, `http://${host}/`] };
}

/** Default true — only false when explicitly disabled. */
export function resolveFollowRedirects(value: unknown): boolean {
  return value !== false;
}

export function resolveHttpxBinary(): string {
  return process.env.REDTEAM_HTTPX_BINARY?.trim() || "httpx";
}

/**
 * Load HTTPX proxy from environment variables or settings.json.
 * Priority: REDTEAM_HTTPX_PROXY env var > settings.json redteam.httpx.proxy
 */
export function resolveHttpxProxy(): string | undefined {
  // Environment variable (highest priority)
  const envProxy = process.env.REDTEAM_HTTPX_PROXY?.trim();
  if (envProxy) return envProxy;

  // settings.json: look for ~/.pi/agent/settings.json or PI_SETTINGS_PATH
  const settingsPath = process.env.PI_SETTINGS_PATH || join(homedir(), ".pi", "agent", "settings.json");
  try {
    if (existsSync(settingsPath)) {
      const content = readFileSync(settingsPath, "utf8");
      const settings = JSON.parse(content);
      const proxy = settings?.redteam?.httpx?.proxy;
      if (typeof proxy === "string" && proxy.trim()) {
        return proxy.trim();
      }
    }
  } catch {
    // Ignore errors reading settings.json
  }

  return undefined;
}

function flagOn(value: unknown, defaultOn: boolean): boolean {
  if (value === false) return false;
  if (value === true) return true;
  return defaultOn;
}

export type HttpxProbeParams = {
  target?: string;
  input?: string;
  timeout_seconds?: number;
  scheme?: string;
  method?: string;
  body?: string;
  follow_redirects?: boolean;
  max_redirects?: number;
  proxy?: string;
  ports?: string;
  path?: string;
  headers?: string[];
  threads?: number;
  rate_limit?: number;
  tech_detect?: boolean;
  tls_grab?: boolean;
  asn?: boolean;
  cdn?: boolean;
  favicon?: boolean;
  jarm?: boolean;
  http2?: boolean;
  include_response_header?: boolean;
  include_response?: boolean;
  body_preview?: number | boolean;
  no_fallback_scheme?: boolean;
};

type RequestHeader = {
  name: string;
  value: string;
};

type ResolvedRequest = {
  method: string;
  body?: string;
  headers: RequestHeader[];
};

const DEFAULT_REQUEST_HEADERS: RequestHeader[] = [
  { name: "User-Agent", value: DEFAULT_UA },
  { name: "Accept", value: "text/html,application/json;q=0.9,*/*;q=0.8" },
];
const SENSITIVE_REQUEST_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "x-api-key",
  "api-key",
]);

function isSensitiveRequestHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return SENSITIVE_REQUEST_HEADERS.has(normalized) || /(authorization|auth|token|secret|api[-_]?key|cookie|session|credential|password)/i.test(normalized);
}

function hasSensitiveRedirectData(request: ResolvedRequest): boolean {
  return request.body !== undefined || request.headers.some((header) => isSensitiveRequestHeader(header.name));
}

/**
 * The probe historically follows redirects by default. Do not forward a body
 * or credentials automatically, however: httpx would otherwise send them to a
 * cross-origin Location without user confirmation.
 */
function resolveEffectiveFollowRedirects(params: HttpxProbeParams, request: ResolvedRequest): boolean {
  return resolveFollowRedirects(params.follow_redirects) && !hasSensitiveRedirectData(request);
}

function redactUrlUserInfo(url: string): string {
  const authorityStart = url.indexOf("://");
  if (authorityStart < 0) return url;
  const start = authorityStart + 3;
  const authorityEnd = ["/", "?", "#"]
    .map((delimiter) => url.indexOf(delimiter, start))
    .filter((index) => index >= 0)
    .reduce((end, index) => Math.min(end, index), url.length);
  const userInfoEnd = url.lastIndexOf("@", authorityEnd - 1);
  if (userInfoEnd < start) return url;
  return `${url.slice(0, start)}[REDACTED]@${url.slice(userInfoEnd + 1)}`;
}

function redactHttpxProxy(proxy: string): string {
  return redactUrlUserInfo(proxy);
}

function redactHttpxArgs(args: string[]): string[] {
  return args.map((arg, index) => {
    const flag = args[index - 1];
    if (flag === "-body") return `[${Buffer.byteLength(arg, "utf8")} byte request body redacted]`;
    if (flag === "-http-proxy") return redactHttpxProxy(arg);
    if (flag === "-u") return redactUrlUserInfo(arg);
    if (flag !== "-H") return arg;

    const separator = arg.indexOf(":");
    const name = separator > 0 ? arg.slice(0, separator).trim() : arg;
    return isSensitiveRequestHeader(name) ? `${name}: [REDACTED]` : arg;
  });
}

/**
 * Normalize the curl-like request fields once so httpx receives the method,
 * payload, and headers. `Headers` rejects malformed or newline-injected header
 * names/values before any request is issued.
 */
export function resolveRequest(params: HttpxProbeParams): ResolvedRequest {
  const method = (params.method ?? "GET").trim().toUpperCase();
  if (!/^[!#$%&'*+.^_`|~0-9A-Z-]+$/.test(method)) {
    throw new Error("method 必须是合法 HTTP 方法 token");
  }

  const body = params.body;
  if (body !== undefined && typeof body !== "string") {
    throw new Error("body 必须是字符串");
  }
  if (body !== undefined && Buffer.byteLength(body, "utf8") > MAX_REQUEST_BODY_BYTES) {
    throw new Error(`body 不能超过 ${MAX_REQUEST_BODY_BYTES} 字节`);
  }
  if (body !== undefined && (method === "GET" || method === "HEAD")) {
    throw new Error(`${method} 请求不能携带 body；请改用 POST、PUT、PATCH 或 DELETE`);
  }

  const customHeaders: RequestHeader[] = [];
  for (const header of params.headers ?? []) {
    if (typeof header !== "string") continue;
    const separator = header.indexOf(":");
    if (separator <= 0) {
      throw new Error(`headers 中的值必须为 Name: Value，收到: ${header}`);
    }
    const name = header.slice(0, separator).trim();
    const value = header.slice(separator + 1).trim();
    if (!name) throw new Error("headers 中的名称不能为空");
    // Validate each pair without collapsing repeated headers.
    new Headers([[name, value]]);
    customHeaders.push({ name, value });
  }

  if (customHeaders.some((header) => /^(content-length|transfer-encoding)$/i.test(header.name))) {
    throw new Error("不允许手动设置 Content-Length 或 Transfer-Encoding；工具会处理请求 framing");
  }

  const customNames = new Set(customHeaders.map((header) => header.name.toLowerCase()));
  const headers = [
    ...DEFAULT_REQUEST_HEADERS.filter((header) => !customNames.has(header.name.toLowerCase())),
    ...customHeaders,
  ];
  if (body !== undefined) {
    headers.push({ name: "Content-Length", value: String(Buffer.byteLength(body, "utf8")) });
  }

  return { method, body, headers };
}

/** Options controlling httpx argv construction. */
export type BuildHttpxArgsOptions = {
  /**
   * Build a lightweight profile that omits heavyweight enrichment (TLS, tech,
   * ASN, CDN, favicon, JARM, HTTP/2, IP, CNAME) and response material
   * (response headers, body preview, full response). Used to retry when the
   * full profile exits 0 with empty stdout on some targets.
   */
  lightweight?: boolean;
};

/** Build PD httpx argv (without binary). */
export function buildHttpxArgs(
  target: string,
  params: HttpxProbeParams,
  proxy?: string,
  options?: BuildHttpxArgsOptions
): string[] {
  const lightweight = options?.lightweight === true;
  const timeout = Math.max(3, params.timeout_seconds ?? 15);
  const maxRedirects = Math.max(
    0,
    Math.min(30, params.max_redirects ?? DEFAULT_MAX_REDIRECTS)
  );
  const request = resolveRequest(params);
  const follow = resolveEffectiveFollowRedirects(params, request);

  const args: string[] = [
    "-u",
    target,
    "-silent",
    "-json",
    "-duc",
    "-timeout",
    String(timeout),
    "-method",
  ];
  if (request.method !== "GET") args.push("-x", request.method);
  if (request.body !== undefined) args.push("-body", request.body);

  const probes: Array<[unknown, boolean, string | string[]]> = lightweight
    ? [
        [undefined, true, ["-title", "-status-code", "-content-length", "-content-type"]],
        [undefined, true, ["-location", "-web-server", "-response-time"]],
      ]
    : [
        [params.tech_detect, true, "-tech-detect"],
        [params.tls_grab, true, "-tls-grab"],
        [params.asn, true, "-asn"],
        [params.cdn, true, "-cdn"],
        [params.favicon, true, "-favicon"],
        [undefined, true, ["-title", "-status-code", "-content-length", "-content-type"]],
        [undefined, true, ["-location", "-web-server", "-ip", "-cname", "-response-time"]],
        [params.jarm, false, "-jarm"],
        [params.http2, false, "-http2"],
      ];

  for (const [val, def, flag] of probes) {
    if (!flagOn(val, def)) continue;
    if (Array.isArray(flag)) args.push(...flag);
    else args.push(flag);
  }

  if (follow) {
    args.push("-follow-redirects", "-max-redirects", String(maxRedirects), "-include-chain");
  }

  if (!lightweight && flagOn(params.include_response_header, true)) {
    args.push("-include-response-header");
  }
  if (!lightweight) {
    if (params.include_response === true) {
      args.push("-include-response");
    } else if (params.body_preview !== false) {
      const n =
        typeof params.body_preview === "number" && params.body_preview > 0
          ? Math.min(1024 * 1024, Math.floor(params.body_preview))
          : DEFAULT_BODY_PREVIEW;
      args.push("-body-preview", String(n));
    }
  }

  if (proxy) {
    args.push("-http-proxy", proxy);
  }
  if (params.ports?.trim()) {
    args.push("-ports", params.ports.trim());
  }
  if (params.path?.trim()) {
    args.push("-path", params.path.trim());
  }
  for (const header of request.headers) {
    args.push("-H", `${header.name}: ${header.value}`);
  }
  if (typeof params.threads === "number" && params.threads > 0) {
    args.push("-threads", String(Math.floor(params.threads)));
  }
  if (typeof params.rate_limit === "number" && params.rate_limit > 0) {
    args.push("-rate-limit", String(Math.floor(params.rate_limit)));
  }
  if (params.no_fallback_scheme === true || params.scheme === "http" || params.scheme === "https") {
    args.push("-no-fallback-scheme");
  }

  return args;
}

export function parseHttpxJsonl(stdout: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      rows.push(JSON.parse(t) as Record<string, unknown>);
    } catch {
      /* skip junk */
    }
  }
  return rows;
}

function chainToRedirects(chain: unknown): {
  redirects: Array<Record<string, unknown>>;
  redirect_count: number;
} {
  if (!Array.isArray(chain)) return { redirects: [], redirect_count: 0 };
  const redirects = chain.map((hop) => {
    if (hop && typeof hop === "object") return hop as Record<string, unknown>;
    return { value: hop };
  });
  return { redirects, redirect_count: Math.max(0, redirects.length - 1) };
}

/** Normalize one httpx JSON row + stable aliases for skills. */
export function normalizeHttpxRow(
  row: Record<string, unknown>
): Record<string, unknown> {
  const title = typeof row.title === "string" ? row.title : undefined;
  const { redirects, redirect_count } = chainToRedirects(row.chain);
  const body =
    typeof row.body === "string"
      ? row.body
      : typeof row.body_preview === "string"
        ? row.body_preview
        : undefined;

  return {
    ...row,
    engine: "httpx",
    response_title: title ?? row.response_title,
    title,
    server: row.webserver ?? row.server,
    final_url: row.final_url ?? row.url,
    ip: row.host_ip ?? row.ip,
    header: row.header,
    body,
    redirects: row.redirects ?? redirects,
    redirect_count:
      typeof row.redirect_count === "number" ? row.redirect_count : redirect_count,
  };
}

function toolTarget(params: HttpxProbeParams): string | undefined {
  const raw = params.target ?? params.input;
  return raw?.trim() || undefined;
}

function resolveCliTarget(raw: string, scheme?: string): string {
  if (/^https?:\/\//i.test(raw)) return raw;
  if (scheme === "http") return `http://${raw.replace(/^\/*/, "")}`;
  if (scheme === "https") return `https://${raw.replace(/^\/*/, "")}`;
  return raw;
}

function httpxRunError(
  message: string,
  args: string[],
  binary: string,
  code: number | null,
  stderrAvailable: boolean
): Record<string, unknown> {
  return {
    error: true,
    engine: "httpx",
    message,
    binary,
    args: redactHttpxArgs(args),
    exit_code: code,
    stderr_available: stderrAvailable,
  };
}

export default function registerHttpxProbe(pi: ExtensionAPI) {
  pi.registerTool({
    name: "httpx_probe",
    label: "HTTP Probe",
    description:
      "通用 HTTP 请求与探测工具：调用本机 ProjectDiscovery httpx（JSONL）。需要先安装 httpx 二进制（或通过 REDTEAM_HTTPX_BINARY 指定路径）。默认保留 title/TLS/tech/ASN/CDN/header/body preview 等探测信息。",
    parameters: Type.Object({
      target: Type.Optional(Type.String({ description: "URL、域名或 IP" })),
      input: Type.Optional(Type.String({ description: "URL、域名或 IP" })),
      timeout_seconds: Type.Optional(Type.Number({ description: "超时秒数，默认 15" })),
      scheme: Type.Optional(
        Type.String({ description: "强制 http 或 https（CLI 会加 -no-fallback-scheme）" })
      ),
      method: Type.Optional(
        Type.String({ description: "HTTP 方法，默认 GET；支持 POST、PUT、PATCH、DELETE、OPTIONS 等标准 token" })
      ),
      body: Type.Optional(
        Type.String({ description: `UTF-8 请求体，最大 ${MAX_REQUEST_BODY_BYTES} 字节；GET/HEAD 不允许携带 body` })
      ),
      follow_redirects: Type.Optional(
        Type.Boolean({ description: "跟随重定向，默认 true" })
      ),
      max_redirects: Type.Optional(
        Type.Number({ description: `最大重定向次数，默认 ${DEFAULT_MAX_REDIRECTS}` })
      ),
      proxy: Type.Optional(
        Type.String({ description: "http|socks 代理，传给 httpx -http-proxy" })
      ),
      ports: Type.Optional(Type.String({ description: "httpx -ports，如 https:443,80" })),
      path: Type.Optional(Type.String({ description: "httpx -path" })),
      headers: Type.Optional(
        Type.Array(Type.String(), {
          description: "自定义请求头，每项为 Name: Value，例如 Accept: application/json 或 Cookie: a=b",
        })
      ),
      threads: Type.Optional(Type.Number()),
      rate_limit: Type.Optional(Type.Number()),
      tech_detect: Type.Optional(Type.Boolean({ description: "默认 true" })),
      tls_grab: Type.Optional(Type.Boolean({ description: "默认 true" })),
      asn: Type.Optional(Type.Boolean({ description: "默认 true" })),
      cdn: Type.Optional(Type.Boolean({ description: "默认 true" })),
      favicon: Type.Optional(Type.Boolean({ description: "默认 true" })),
      jarm: Type.Optional(Type.Boolean({ description: "默认 false" })),
      http2: Type.Optional(Type.Boolean({ description: "默认 false" })),
      include_response_header: Type.Optional(
        Type.Boolean({ description: "默认 true → -irh，输出 header" })
      ),
      include_response: Type.Optional(
        Type.Boolean({ description: "默认 false → -irr 含完整 body" })
      ),
      body_preview: Type.Optional(
        Type.Union([Type.Number(), Type.Boolean()], {
          description: `body 预览字节，默认 ${DEFAULT_BODY_PREVIEW}；false 关闭`,
        })
      ),
      no_fallback_scheme: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, signal, _onUpdate, _ctx) {
      const p = params as HttpxProbeParams;
      const raw = toolTarget(p);
      if (!raw) {
        return {
          content: [{ type: "text", text: "缺少 target 或 input 参数" }],
          details: {},
          isError: true,
        };
      }

      let request: ResolvedRequest;
      try {
        request = resolveRequest(p);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `请求参数无效: ${message}` }],
          details: { error: true, message: "invalid request parameters" },
          isError: true,
        };
      }

      let host: string;
      try {
        ({ host } = buildUrls(
          raw,
          p.scheme === "http" || p.scheme === "https" ? p.scheme : undefined
        ));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          details: {},
          isError: true,
        };
      }

      // proxy === "" disables; omit → config/env REDTEAM_HTTPX_PROXY
      const proxy = p.proxy === undefined
        ? resolveHttpxProxy()
        : p.proxy.trim()
          ? p.proxy.trim()
          : undefined;
      const binary = resolveHttpxBinary();
      const cliTarget = resolveCliTarget(
        raw,
        p.scheme === "http" || p.scheme === "https" ? p.scheme : undefined
      );

      const runAndReturn = async (
        args: string[],
        extra?: Record<string, unknown>
      ): Promise<
        | {
            content: Array<{ type: "text"; text: string }>;
            details: Record<string, unknown>;
            isError?: boolean;
          }
        | { empty: true; code: number | null; stderrAvailable: boolean }
      > => {
        let code: number | null;
        let stdout: string;
        let stderr: string;
        try {
          ({ code, stdout, stderr } = await httpxRunner(binary, args, signal));
        } catch (error) {
          const err = error as NodeJS.ErrnoException;
          if (err?.code === "ENOENT") {
            const message =
              "未找到 httpx 二进制。请安装 ProjectDiscovery httpx，或设置 REDTEAM_HTTPX_BINARY 环境变量（或 config/config.yaml 的 httpx.binary）指向其路径。";
            return {
              content: [{ type: "text", text: message }],
              details: { error: true, engine: "httpx", message, binary },
              isError: true,
            };
          }
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text", text: message }],
            details: { error: true, engine: "httpx", message, binary, args: redactHttpxArgs(args) },
            isError: true,
          };
        }

        const stderrAvailable = Boolean(stderr.trim());
        if (code !== 0) {
          const message = `httpx exited with code ${code ?? "unknown"}${stderrAvailable ? "; diagnostics omitted to protect secrets" : ""}`;
          return {
            content: [{ type: "text", text: message }],
            details: httpxRunError(message, args, binary, code, stderrAvailable),
            isError: true,
          };
        }

        const rows = parseHttpxJsonl(stdout);
        if (rows.length > 0) {
          const normalized = rows.map((r) => normalizeHttpxRow(r));
          const first = normalized[0]!;
          const payload: Record<string, unknown> = {
            target: redactUrlUserInfo(raw),
            host,
            request_method: request.method,
            requested_follow_redirects: resolveFollowRedirects(p.follow_redirects),
            redirects_limited_for_sensitive_request:
              resolveFollowRedirects(p.follow_redirects) && !resolveEffectiveFollowRedirects(p, request),
            request_body_bytes: request.body === undefined ? undefined : Buffer.byteLength(request.body, "utf8"),
            binary,
            args: redactHttpxArgs(args),
            ...first,
            results: normalized.length > 1 ? normalized : undefined,
            stderr_available: stderrAvailable,
            exit_code: code,
            ...extra,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
            details: payload,
          };
        }

        return { empty: true, code, stderrAvailable };
      };

      const fullArgs = buildHttpxArgs(cliTarget, p, proxy);
      const fullResult = await runAndReturn(fullArgs);
      if (!("empty" in fullResult)) return fullResult;

      // Only retry safe body-less GET/HEAD requests to avoid re-sending a
      // mutating request. The full profile can exit 0 with empty stdout on
      // some targets; retry once with a lightweight profile (still httpx).
      const safeToRetry = request.body === undefined && (request.method === "GET" || request.method === "HEAD");
      if (!safeToRetry) {
        const message = `httpx 未返回可解析的 JSON 结果；为避免重复执行 ${request.method} 请求，未自动重试。`;
        return {
          content: [{ type: "text", text: message }],
          details: {
            error: true,
            engine: "httpx",
            message,
            binary,
            args: redactHttpxArgs(fullArgs),
          },
          isError: true,
        };
      }

      const retryArgs = buildHttpxArgs(cliTarget, p, proxy, { lightweight: true });
      const retryResult = await runAndReturn(retryArgs, {
        httpx_empty_result: {
          engine: "httpx",
          message: "httpx exited successfully without parseable JSON results",
          binary,
          args: redactHttpxArgs(fullArgs),
          exit_code: fullResult.code,
          stderr_available: fullResult.stderrAvailable,
        },
        httpx_retried: true,
      });
      if (!("empty" in retryResult)) return retryResult;

      const message = "httpx 未返回可解析的 JSON 结果（完整与轻量 profile 均空）。";
      return {
        content: [{ type: "text", text: message }],
        details: {
          error: true,
          engine: "httpx",
          message,
          binary,
          args: redactHttpxArgs(retryArgs),
        },
        isError: true,
      };
    },
  });
}
