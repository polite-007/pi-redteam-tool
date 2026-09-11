/**
 * WHOIS/RDAP extension for Pi Coding Agent.
 * Domain registration lookup via RDAP/WHOIS.
 ...
 */
import { connect as netConnect } from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const IPV4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

const JPNIC_RDAP = "https://jpnic.rdap.apnic.net";
const JPNIC_WHOIS_HOST = "whois.nic.ad.jp";
const JPNIC_WHOIS_PORT = 43;

function stripPort(host: string): string {
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

function isIpAddress(host: string): boolean {
  return IPV4.test(host) || (host.includes(":") && !host.includes("."));
}

export function resolveHost(input: string): { host: string; isIp: boolean } {
  const raw = input.trim();
  if (!raw) throw new Error("缺少 target 或 input");
  if (IPV4.test(raw)) return { host: raw, isIp: true };
  if (raw.startsWith("[") && raw.includes("]")) {
    return { host: stripPort(raw), isIp: true };
  }
  if (raw.includes(":") && !raw.includes(".")) {
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

export type WhoisGateway = "auto" | "jpnic" | "apnic" | "arin" | "ripe" | "rdap";

export function normalizeGateway(raw: unknown): WhoisGateway {
  const v = String(raw ?? "auto").trim().toLowerCase();
  if (v === "jpnic" || v === "apnic" || v === "arin" || v === "ripe" || v === "rdap") {
    return v;
  }
  return "auto";
}

export type LookupStep =
  | { kind: "rdap"; label: string; url: string }
  | { kind: "jpnic-whois"; label: string };

/** Build ordered RDAP/WHOIS candidate descriptors. */
export function buildLookupPlan(
  host: string,
  isIp: boolean,
  gateway: WhoisGateway
): LookupStep[] {
  if (!isIp) {
    return [
      { kind: "rdap", label: "rdap.org", url: `https://rdap.org/domain/${encodeURIComponent(host)}` },
      {
        kind: "rdap",
        label: "verisign-com",
        url: `https://rdap.verisign.com/com/v1/domain/${encodeURIComponent(host)}`,
      },
    ];
  }

  const apnic: LookupStep = {
    kind: "rdap",
    label: "apnic",
    url: `https://rdap.apnic.net/ip/${encodeURIComponent(host)}`,
  };
  const jpnicRdap: LookupStep = {
    kind: "rdap",
    label: "jpnic-rdap",
    url: `${JPNIC_RDAP}/ip/${encodeURIComponent(host)}`,
  };
  const jpnicWhois: LookupStep = { kind: "jpnic-whois", label: "jpnic-whois" };
  const arin: LookupStep = {
    kind: "rdap",
    label: "arin",
    url: `https://rdap.arin.net/registry/ip/${encodeURIComponent(host)}`,
  };
  const ripe: LookupStep = {
    kind: "rdap",
    label: "ripe",
    url: `https://rdap.db.ripe.net/ip/${encodeURIComponent(host)}`,
  };
  const rdapOrg: LookupStep = {
    kind: "rdap",
    label: "rdap.org",
    url: `https://rdap.org/ip/${encodeURIComponent(host)}`,
  };

  if (gateway === "jpnic") return [jpnicRdap, jpnicWhois, apnic];
  if (gateway === "apnic") return [apnic, jpnicRdap, jpnicWhois];
  if (gateway === "arin") return [arin, rdapOrg];
  if (gateway === "ripe") return [ripe, rdapOrg];
  if (gateway === "rdap") return [rdapOrg, apnic, arin, ripe];

  // auto: bootstrap + JPNIC (Japan allocations often thin at APNIC)
  return [rdapOrg, jpnicRdap, apnic, jpnicWhois, arin, ripe];
}

export function parseVcard(vcardArray: unknown): {
  name?: string;
  org?: string;
  email?: string;
  phone?: string;
  address?: string;
} {
  const out: {
    name?: string;
    org?: string;
    email?: string;
    phone?: string;
    address?: string;
  } = {};
  if (!Array.isArray(vcardArray) || !Array.isArray(vcardArray[1])) return out;
  for (const item of vcardArray[1] as unknown[]) {
    if (!Array.isArray(item) || item.length < 4) continue;
    const key = String(item[0]).toLowerCase();
    const val = item[3];
    if (key === "fn" && typeof val === "string") out.name = val;
    else if (key === "org" && typeof val === "string") out.org = val;
    else if (key === "email" && typeof val === "string") out.email = val;
    else if (key === "tel" && typeof val === "string") out.phone = val;
    else if (key === "adr") {
      if (Array.isArray(val)) out.address = val.filter(Boolean).join(", ");
      else if (typeof val === "string") out.address = val;
    }
  }
  return out;
}

function entitySummary(entities: unknown, depth = 0): Array<Record<string, unknown>> {
  if (!Array.isArray(entities) || depth > 2) return [];
  const rows: Array<Record<string, unknown>> = [];
  for (const ent of entities.slice(0, 20)) {
    const e = ent as {
      handle?: string;
      roles?: string[];
      vcardArray?: unknown;
      remarks?: Array<{ title?: string; description?: string[] }>;
      entities?: unknown;
    };
    const vcard = parseVcard(e.vcardArray);
    const remarks = Array.isArray(e.remarks)
      ? e.remarks.slice(0, 4).map((r) => ({
          title: r.title,
          description: Array.isArray(r.description)
            ? r.description.slice(0, 4).join(" ")
            : undefined,
        }))
      : undefined;
    rows.push({
      handle: e.handle,
      roles: e.roles,
      ...vcard,
      remarks,
      entities: e.entities ? entitySummary(e.entities, depth + 1) : undefined,
    });
  }
  return rows;
}

function remarkTexts(data: Record<string, unknown>): string[] {
  if (!Array.isArray(data.remarks)) return [];
  const out: string[] = [];
  for (const r of data.remarks as Array<{ title?: string; description?: string[] }>) {
    const desc = Array.isArray(r.description) ? r.description.join(" ") : "";
    const line = [r.title, desc].filter(Boolean).join(": ").trim();
    if (line) out.push(line.slice(0, 500));
    if (out.length >= 8) break;
  }
  return out;
}

function noticeTexts(data: Record<string, unknown>): string[] {
  if (!Array.isArray(data.notices)) return [];
  const out: string[] = [];
  for (const n of data.notices as Array<{ title?: string; description?: string[] }>) {
    const desc = Array.isArray(n.description) ? n.description.join(" ") : "";
    const line = [n.title, desc].filter(Boolean).join(": ").trim();
    if (line) out.push(line.slice(0, 400));
    if (out.length >= 6) break;
  }
  return out;
}

export function summarizeRdap(data: Record<string, unknown>) {
  const entities = entitySummary(data.entities);
  const abuse = entities.find(
    (e) => Array.isArray(e.roles) && (e.roles as string[]).some((r) => /abuse/i.test(r))
  );
  const registrant = entities.find(
    (e) =>
      Array.isArray(e.roles) &&
      (e.roles as string[]).some((r) => /registrant|registration/i.test(r))
  );

  return {
    objectClassName: data.objectClassName,
    handle: data.handle,
    name: data.name,
    ldhName: data.ldhName,
    unicodeName: data.unicodeName,
    country: data.country,
    status: data.status,
    type: data.type,
    startAddress: data.startAddress,
    endAddress: data.endAddress,
    ipVersion: data.ipVersion,
    cidr0_cidrs: data.cidr0_cidrs,
    network: data.network,
    parentHandle: data.parentHandle,
    events: Array.isArray(data.events)
      ? (data.events as Array<{ eventAction?: string; eventDate?: string }>).slice(0, 12)
      : undefined,
    entities,
    abuseEmail: abuse?.email,
    abuseName: abuse?.name ?? abuse?.org,
    registrantName: registrant?.name ?? registrant?.org,
    registrantEmail: registrant?.email,
    remarks: remarkTexts(data),
    notices: noticeTexts(data),
    port43: data.port43,
    secureDNS: data.secureDNS,
    nameservers: Array.isArray(data.nameservers)
      ? (data.nameservers as Array<{ ldhName?: string }>)
          .map((ns) => ns.ldhName)
          .filter(Boolean)
          .slice(0, 12)
      : undefined,
    links: Array.isArray(data.links)
      ? (data.links as Array<{ rel?: string; href?: string }>)
          .filter((l) => l.rel === "self" || l.rel === "related" || l.rel === "alternate")
          .slice(0, 8)
      : undefined,
  };
}

/** Parse JPNIC port-43 whois text into a flat summary. */
export function parseJpnicWhois(text: string): Record<string, unknown> {
  const fields: Record<string, string> = {};
  const keyMap: Record<string, string> = {
    "Network Number": "networkNumber",
    "Network Name": "networkName",
    "Network Type": "networkType",
    Organization: "organization",
    "Organization Name": "organizationName",
    "Admin Contact": "adminContact",
    "Technical Contact": "technicalContact",
    "Abuse Contact": "abuseContact",
    "Allocation Date": "allocationDate",
    "Last Update": "lastUpdate",
  };

  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9 /.-]*?)\s*:\s*(.+)$/);
    if (!m) continue;
    const label = m[1]!.trim();
    const value = m[2]!.trim();
    const mapped = keyMap[label];
    if (mapped && !fields[mapped]) fields[mapped] = value;
  }

  const emails = [...text.matchAll(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g)].map((x) => x[0]!);
  const uniqEmails = [...new Set(emails)].slice(0, 8);

  return {
    source: "jpnic-whois",
    networkNumber: fields.networkNumber,
    networkName: fields.networkName,
    networkType: fields.networkType,
    organization: fields.organization ?? fields.organizationName,
    organizationName: fields.organizationName ?? fields.organization,
    adminContact: fields.adminContact,
    technicalContact: fields.technicalContact,
    abuseContact: fields.abuseContact,
    emails: uniqEmails,
    abuseEmail: uniqEmails.find((e) => /abuse/i.test(e)) ?? uniqEmails[0],
    allocationDate: fields.allocationDate,
    lastUpdate: fields.lastUpdate,
    country: "JP",
    name: fields.networkName ?? fields.organizationName ?? fields.organization,
  };
}

export function queryJpnicWhois(
  host: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string> {
  // /e requests English output when available
  const query = `NET ${host}/e\r\n`;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      return;
    }

    const socket = netConnect({ host: JPNIC_WHOIS_HOST, port: JPNIC_WHOIS_PORT });
    const chunks: Buffer[] = [];
    let settled = false;

    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(Buffer.concat(chunks).toString("utf8"));
    };

    const onAbort = () => done(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const timer = setTimeout(
      () => done(Object.assign(new Error(`timeout/${timeoutMs}ms`), { name: "AbortError" })),
      timeoutMs
    );
    signal?.addEventListener("abort", onAbort, { once: true });

    socket.setTimeout(timeoutMs);
    socket.on("connect", () => {
      socket.write(query);
    });
    socket.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    socket.on("end", () => done());
    socket.on("error", (err) => done(err));
    socket.on("timeout", () =>
      done(Object.assign(new Error(`timeout/${timeoutMs}ms`), { name: "AbortError" }))
    );
  });
}

function jpnicWhoisLooksValid(text: string, summary: Record<string, unknown>): boolean {
  if (/No match!!/i.test(text) || /No Entries found/i.test(text)) return false;
  return Boolean(summary.networkNumber || summary.networkName || summary.organization);
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "whois_rdap",
    label: "WHOIS RDAP",
    description:
      "通过 RDAP/WHOIS 查询 IP/域名。默认 auto（含 JPNIC RDAP + whois.nic.ad.jp）。gateway=jpnic 可强制日本网关。raw=true 返回原文。",
    parameters: Type.Object({
      target: Type.Optional(Type.String({ description: "IP、域名或 URL" })),
      input: Type.Optional(Type.String({ description: "IP、域名或 URL" })),
      gateway: Type.Optional(
        Type.String({
          description: "auto|jpnic|apnic|arin|ripe|rdap，默认 auto（IP 会尝试 JPNIC）",
        })
      ),
      raw: Type.Optional(
        Type.Boolean({ description: "true 时返回完整 RDAP JSON 或 JPNIC whois 原文" })
      ),
      timeout_seconds: Type.Optional(Type.Number({ description: "超时秒数，默认 20" })),
    }),
    async execute(_id, params, signal) {
      const rawInput = params.target ?? params.input;
      if (!rawInput?.trim()) {
        return {
          content: [{ type: "text", text: "缺少 target 或 input 参数" }],
          details: {},
          isError: true,
        };
      }

      let host: string;
      let isIp: boolean;
      try {
        ({ host, isIp } = resolveHost(rawInput));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          details: {},
          isError: true,
        };
      }

      const gateway = normalizeGateway(params.gateway);
      const plan = buildLookupPlan(host, isIp, gateway);
      const timeoutMs = Math.max(3, params.timeout_seconds ?? 20) * 1000;
      const tried: string[] = [];
      let lastErr: { message: string; label?: string; status?: number } | null = null;

      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort);
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        for (const step of plan) {
          tried.push(step.label);
          try {
            if (step.kind === "jpnic-whois") {
              const text = await queryJpnicWhois(host, timeoutMs, controller.signal);
              const parsed = parseJpnicWhois(text);
              if (!jpnicWhoisLooksValid(text, parsed)) {
                lastErr = { message: "JPNIC whois no match", label: step.label };
                continue;
              }
              if (params.raw === true) {
                const payload = {
                  target: rawInput.trim(),
                  host,
                  gateway,
                  source: step.label,
                  mode: "raw",
                  whois: text,
                };
                return {
                  content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
                  details: payload,
                };
              }
              const summary = {
                target: rawInput.trim(),
                host,
                gateway,
                url: `whois://${JPNIC_WHOIS_HOST}/${host}`,
                mode: "summary",
                ...parsed,
              };
              return {
                content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
                details: summary,
              };
            }

            const res = await fetch(step.url, {
              signal: controller.signal,
              headers: { Accept: "application/rdap+json, application/json" },
              redirect: "follow",
            });
            if (!res.ok) {
              lastErr = {
                message: `RDAP HTTP ${res.status}`,
                label: step.label,
                status: res.status,
              };
              if (res.status === 429) break;
              continue;
            }
            const data = (await res.json()) as Record<string, unknown>;

            if (params.raw === true) {
              const payload = {
                target: rawInput.trim(),
                host,
                gateway,
                source: step.label,
                url: step.url,
                mode: "raw",
                rdap: data,
              };
              return {
                content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
                details: payload,
              };
            }

            const summary = {
              target: rawInput.trim(),
              host,
              gateway,
              source: step.label,
              url: step.url,
              mode: "summary",
              ...summarizeRdap(data),
            };
            return {
              content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
              details: summary,
            };
          } catch (error) {
            if (controller.signal.aborted) break;
            lastErr = {
              message: error instanceof Error ? error.message : String(error),
              label: step.label,
            };
          }
        }

        const err = {
          error: true,
          message: lastErr?.message ?? "WHOIS/RDAP 全部源失败",
          host,
          gateway,
          tried,
          lastStatus: lastErr?.status,
          hint: "日本地址可试 gateway=jpnic；rdap.org 失败时会回退 JPNIC/APNIC/ARIN/RIPE",
        };
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
