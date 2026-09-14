/**
 * WeChat Article extension for Pi Coding Agent.
 * Fetches articles from WeChat public accounts.
 *
 * Technical notes (based on WeChat public account article access research):
 *  - Direct connection: Default bypasses any proxy. Tencent MMLAS edge gateway has very low
 *    trust score for proxy/IDC exit IPs, triggering 302 to captcha page on detection.
 *    Node global fetch (undici) defaults to direct connection and ignores http_proxy/https_proxy,
 *    satisfying the "local direct connection" requirement.
 *  - Real browser fingerprint: Chrome desktop / WeChat built-in browser UA + complete navigation headers
 *    (Accept / Accept-Language / Sec-Fetch-* / Upgrade-Insecure-Requests).
 *  - Success/failure detection: Final URL landing on /mp/wappoc_appmsgcaptcha, `retkey` response header,
 *    captcha page text / TCaptcha.js signature.
 *  - Content extraction: `rich_media_title` / `js_name` / `publish_time` / `js_content` DOM anchors,
 *    stripping tags to plain text (no external HTML parsing dependencies).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const WECHAT_UA =
  "Mozilla/5.0 (Linux; Android 10; Pixel 3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36 MicroMessenger/8.0.40";

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // 完整正文约 3.19 MB，留足余量
const DEFAULT_TIMEOUT_MS = 30 * 1000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_CONTENT_CHARS = 20000;

export type UaPreset = "chrome" | "wechat";

export type WxArticleParams = {
  target?: string;
  input?: string;
  ua?: string;
  scene?: string;
  from?: string;
  timeout_seconds?: number;
  max_redirects?: number;
  extract?: boolean;
  max_content_chars?: number;
  raw_html?: boolean;
};

/** 输入可以是完整 URL，也可以是裸 mid（2E5csFBC0kCBV8biVdSatA）。可追加 scene/from 场景参数。 */
export function buildArticleUrl(input: string, scene?: string, from?: string): string {
  const raw = input.trim();
  if (!raw) throw new Error("缺少 target 或 input");
  const url = /^https?:\/\//i.test(raw)
    ? new URL(raw)
    : new URL(`https://mp.weixin.qq.com/s/${raw.replace(/^\/+/, "")}`);
  if (scene) url.searchParams.set("scene", scene);
  if (from) url.searchParams.set("from", from);
  return url.href;
}

/** 真实浏览器导航头。默认 Chrome 桌面；wechat 预设模拟微信内置浏览器。 */
export function buildHeaders(preset: UaPreset, customUa?: string): Record<string, string> {
  const userAgent =
    customUa?.trim() || (preset === "wechat" ? WECHAT_UA : CHROME_UA);
  const headers: Record<string, string> = {
    "User-Agent": userAgent,
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Upgrade-Insecure-Requests": "1",
  };
  if (preset === "wechat") {
    headers.Accept =
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
    headers.Referer = "https://mp.weixin.qq.com/";
  } else {
    headers.Accept =
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
    headers["Sec-Fetch-Dest"] = "document";
    headers["Sec-Fetch-Mode"] = "navigate";
    headers["Sec-Fetch-Site"] = "none";
  }
  return headers;
}

export type RedirectHop = {
  status: number;
  url: string;
  location?: string;
  retkey?: string;
  mmlas?: string;
};

type FetchResult = {
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  redirects: RedirectHop[];
};

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

async function readBodyLimited(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const buf = Buffer.from(value);
        if (total + buf.length > maxBytes) {
          chunks.push(buf.subarray(0, maxBytes - total));
          total = maxBytes;
          break;
        }
        chunks.push(buf);
        total += buf.length;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/**
 * 手动跟随重定向，记录每一跳（302 到验证码页时 `retkey` / `mmlas-verifyresult` 头
 * 是风控指纹）。直连：undici fetch 默认不读代理环境变量。
 */
export async function fetchArticleHtml(
  url: string,
  opts: {
    headers: Record<string, string>;
    timeoutMs?: number;
    maxBytes?: number;
    maxRedirects?: number;
    signal?: AbortSignal;
  }
): Promise<FetchResult> {
  const {
    headers,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
  } = opts;

  const redirects: RedirectHop[] = [];
  let current = url;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetch(current, {
        headers,
        redirect: "manual",
        // undici 专有选项（自动 Accept-Encoding + 解压），DOM RequestInit 无此字段
        compress: true,
        signal: controller.signal,
      } as RequestInit);
    } catch (error) {
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      const aborted =
        signal?.aborted || (error instanceof Error && error.name === "AbortError");
      throw new Error(
        aborted ? `timeout/${timeoutMs}ms` : error instanceof Error ? error.message : String(error)
      );
    }
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);

    const resHeaders = headersToObject(res.headers);
    const location = resHeaders.location;

    if (res.status >= 300 && res.status < 400 && location) {
      redirects.push({
        status: res.status,
        url: current,
        location,
        retkey: resHeaders.retkey,
        mmlas: resHeaders["mmlas-verifyresult"],
      });
      current = new URL(location, current).href;
      continue;
    }

    const body = await readBodyLimited(res, maxBytes);
    return { finalUrl: current, status: res.status, headers: resHeaders, body, redirects };
  }

  throw new Error(`too many redirects (>${maxRedirects})`);
}

export type WxVerdict = "ok" | "blocked" | "error";

export function judgeResponse(p: {
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}): { verdict: WxVerdict; reason: string } {
  const bodyText = p.body.toString("utf8");
  const captchaByUrl = /wappoc_appmsgcaptcha/i.test(p.finalUrl);
  const captchaByBody =
    /wappoc_appmsgcaptcha/i.test(bodyText) ||
    /环境异常，完成验证后即可继续访问/i.test(bodyText) ||
    /TCaptcha\.js/i.test(bodyText);

  // 注意：retkey 头在成功响（200 正文）上也会出现，不单独作为拦截信号。
  // 拦截与否只看：最终 URL 是否落到验证码页 / 响应体是否验证码页。
  if (captchaByUrl) return { verdict: "blocked", reason: "captcha_redirect" };
  if (captchaByBody) return { verdict: "blocked", reason: "captcha_page" };
  if (p.status >= 200 && p.status < 400) {
    return {
      verdict: "ok",
      reason: /rich_media_content|js_content/i.test(bodyText)
        ? "article_html"
        : `http_${p.status}`,
    };
  }
  return { verdict: "error", reason: `http_${p.status}` };
}

function stripHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&ldquo;/gi, '“')
    .replace(/&rdquo;/gi, '”')
    .replace(/&hellip;/gi, "…")
    .replace(/&mdash;|&ndash;/gi, "—")
    .replace(/ /gi, " ");
}

function stripHtmlToText(s: string): string {
  return stripHtmlEntities(s)
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** 匹配带标签元素，去标签取纯文本。 */
export function matchTagText(html: string, re: RegExp): string | undefined {
  const m = html.match(re);
  if (!m?.[1]) return undefined;
  const text = stripHtmlToText(m[1]);
  return text || undefined;
}

/**
 * 从正文容器（id="js_content" 或 class="rich_media_content"）提取纯文本。
 * 容器闭合的 `</div>` 后紧跟 `<script>`，截取到该处即可得到正文 HTML。
 */
export function extractContentText(html: string): string | undefined {
  let start = html.indexOf('id="js_content"');
  if (start < 0) start = html.indexOf('class="rich_media_content');
  if (start < 0) return undefined;
  const tagEnd = html.indexOf(">", start);
  if (tagEnd < 0) return undefined;
  let end = html.indexOf("<script", tagEnd);
  if (end < 0) end = html.length;
  let raw = html.slice(tagEnd + 1, end);
  const closeIdx = raw.lastIndexOf("</div>");
  if (closeIdx >= 0) raw = raw.slice(0, closeIdx);
  const text = stripHtmlToText(raw);
  return text || undefined;
}

export function extractArticle(html: string): {
  title?: string;
  author?: string;
  publishTime?: string;
  contentText?: string;
  contentChars?: number;
} {
  const title = matchTagText(html, /<h1[^>]*class="[^"]*rich_media_title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
  const author = matchTagText(html, /<[^>]*id="js_name"[^>]*>([\s\S]*?)<\/[^>]+>/i);
  const publishTime = matchTagText(html, /<[^>]*id="publish_time"[^>]*>([\s\S]*?)<\/[^>]+>/i);
  const contentText = extractContentText(html);
  return {
    title,
    author,
    publishTime,
    contentText,
    contentChars: contentText ? contentText.length : undefined,
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "wx_article",
    label: "WeChat Article",
    description:
      "获取微信公众平台公开文章（https://mp.weixin.qq.com/s/<mid>）。默认本机直连 + 真实浏览器 UA（Chrome 桌面 / 微信内置）以绕过 MMLAS 风控拦截；成功时提取标题/公众号/发布时间/正文纯文本。不走代理（代理出口 IP 易触发验证码）。",
    parameters: Type.Object({
      target: Type.Optional(
        Type.String({ description: "文章 URL（https://mp.weixin.qq.com/s/<mid>）或裸 mid" })
      ),
      input: Type.Optional(Type.String({ description: "同 target，二选一" })),
      ua: Type.Optional(
        Type.String({ description: "预设：chrome | wechat；或任意自定义 UA 字符串" })
      ),
      scene: Type.Optional(Type.String({ description: "场景参数，如 25 / timeline" })),
      from: Type.Optional(Type.String({ description: "来源参数，如 timeline" })),
      timeout_seconds: Type.Optional(Type.Number({ description: `超时秒数，默认 ${DEFAULT_TIMEOUT_MS / 1000}` })),
      max_redirects: Type.Optional(Type.Number({ description: `最大重定向数，默认 ${DEFAULT_MAX_REDIRECTS}` })),
      extract: Type.Optional(Type.Boolean({ description: "提取标题/作者/时间/正文，默认 true" })),
      max_content_chars: Type.Optional(
        Type.Number({ description: `正文纯文本截断长度，默认 ${DEFAULT_MAX_CONTENT_CHARS}` })
      ),
      raw_html: Type.Optional(Type.Boolean({ description: "额外返回正文 HTML 片段，默认 false" })),
    }),
    async execute(_id, params, signal) {
      const p = params as WxArticleParams;
      const raw = p.target ?? p.input;
      if (!raw?.trim()) {
        return {
          content: [{ type: "text", text: "缺少 target 或 input 参数" }],
          details: {},
          isError: true,
        };
      }

      let url: string;
      try {
        url = buildArticleUrl(raw, p.scene, p.from);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: message }], details: {}, isError: true };
      }

      const isWechat = p.ua === "wechat";
      const customUa = p.ua && p.ua !== "chrome" && p.ua !== "wechat" ? p.ua : undefined;
      const headers = buildHeaders(isWechat ? "wechat" : "chrome", customUa);

      const timeoutMs = Math.max(3, p.timeout_seconds ?? DEFAULT_TIMEOUT_MS / 1000) * 1000;
      const maxRedirects = Math.max(0, Math.min(10, p.max_redirects ?? DEFAULT_MAX_REDIRECTS));

      let res: FetchResult;
      try {
        res = await fetchArticleHtml(url, {
          headers,
          timeoutMs,
          maxRedirects,
          signal,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          details: { error: true, url, message },
          isError: true,
        };
      }

      const { verdict, reason } = judgeResponse(res);
      const bodyText = res.body.toString("utf8");
      const maxContentChars = Math.max(0, p.max_content_chars ?? DEFAULT_MAX_CONTENT_CHARS);
      const extract = p.extract !== false;

      const extracted = extract ? extractArticle(bodyText) : {};
      const contentText = extracted.contentText
        ? extracted.contentText.slice(0, maxContentChars)
        : undefined;

      // retkey / mmlas 头通常在 302 那一跳上，最终页拿不到时从重定向链回退
      const redirectRetkey = res.redirects.find(
        (r) => r.retkey && r.retkey !== "0"
      )?.retkey;
      const redirectMmlas = res.redirects.find(
        (r) => r.mmlas && r.mmlas.trim()
      )?.mmlas;

      const payload: Record<string, unknown> = {
        target: raw.trim(),
        url,
        final_url: res.finalUrl,
        status: res.status,
        verdict,
        reason,
        size: res.body.length,
        redirects: res.redirects,
        retkey: res.headers.retkey ?? redirectRetkey,
        mmlas_verifyresult: res.headers["mmlas-verifyresult"] ?? redirectMmlas,
      };

      if (extracted.title) payload.title = extracted.title;
      if (extracted.author) payload.author = extracted.author;
      if (extracted.publishTime) payload.publish_time = extracted.publishTime;
      if (contentText) payload.content_text = contentText;
      if (extracted.contentChars) payload.content_chars = extracted.contentChars;
      if (p.raw_html === true && res.body.length > 0) {
        payload.content_html = bodyText;
      }

      const isBlocked = verdict === "blocked";
      const text = isBlocked
        ? `wx_article 被风控拦截（${reason}）：${res.finalUrl}`
        : JSON.stringify(payload, null, 2);

      return {
        content: [{ type: "text", text }],
        details: payload,
        isError: verdict === "error" || isBlocked,
      };
    },
  });
}
