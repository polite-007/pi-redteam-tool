/**
 * Network lookup extension for Pi Coding Agent.
 *
 * One tool, three lookup modes:
 * - `bgp`: routing view (ASN / prefix / access-vs-infrastructure classification)
 *   via BGPView.
 * - `whois`: registration view via RDAP/WHOIS (IPs and domains, JPNIC aware).
 * - `all`: both in parallel, merged into a single attribution assessment.
 *
 * `mode=auto` (default) picks `all` for IPs and `whois` for domains.
 */
import { connect as netConnect } from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const IPV4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

const JPNIC_RDAP = "https://jpnic.rdap.apnic.net";
const JPNIC_WHOIS_HOST = "whois.nic.ad.jp";
const JPNIC_WHOIS_PORT = 43;

/* ------------------------------------------------------------------ *
 * Shared target parsing
 * ------------------------------------------------------------------ */

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

/** BGP mode is IPv4-only; this keeps the old helper's error message. */
export function resolveIp(input: string): string {
  const { host, isIp } = resolveHost(input);
  if (!isIp || !IPV4.test(host)) throw new Error("bgp 模式目前仅支持 IPv4");
  return host;
}

export type LookupMode = "auto" | "bgp" | "whois" | "all";

/** Returns `undefined` for an unrecognised value so a typo never silently runs. */
export function normalizeMode(raw: unknown): LookupMode | undefined {
  const v = String(raw ?? "auto").trim().toLowerCase();
  if (v === "" || v === "auto") return "auto";
  if (v === "bgp" || v === "whois" || v === "all") return v;
  if (v === "rdap" || v === "whois-rdap") return "whois";
  return undefined;
}

/* ------------------------------------------------------------------ *
 * BGP mode (BGPView)
 * ------------------------------------------------------------------ */

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
    hint: bgpHint(usage.classification),
  };
}

function bgpHint(classification: BgpUsageClass): string {
  return classification === "customer_access"
    ? "更像接入网/客户地址池；网络所有者≠终端使用机构"
    : classification === "infrastructure"
      ? "更像基础设施/骨干/托管；可偏向 org_is_infra_provider"
      : classification === "transit_or_isp"
        ? "ISP/聚合段信号；慎下 org_uses_ip，优先 network_owner"
        : "BGP 信号不足，需结合 PTR/被动DNS/HTTP";
}

type BgpResult =
  | { ok: true; url: string; data: BgpViewIpResponse; summary: ReturnType<typeof summarizeBgpView> }
  | { ok: false; url: string; error: string; status?: number; skipped?: boolean };

async function runBgp(
  host: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<BgpResult> {
  const url = `https://api.bgpview.io/ip/${encodeURIComponent(host)}`;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "pi-redteam-net-lookup/0.1" },
    });
    if (!res.ok) {
      return { ok: false, url, error: `BGPView HTTP ${res.status}`, status: res.status };
    }
    const data = (await res.json()) as BgpViewIpResponse;
    return { ok: true, url, data, summary: summarizeBgpView(host, data) };
  } catch (error) {
    const timedOut = controller.signal.aborted && !signal?.aborted;
    const message = timedOut
      ? `timeout/${timeoutMs}ms`
      : error instanceof Error
        ? error.message
        : String(error);
    return { ok: false, url, error: message };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/* ------------------------------------------------------------------ *
 * WHOIS / RDAP mode
 * ------------------------------------------------------------------ */

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

type WhoisResult =
  | {
      ok: true;
      kind: "rdap";
      source: string;
      url: string;
      data: Record<string, unknown>;
      summary: Record<string, unknown>;
    }
  | {
      ok: true;
      kind: "jpnic-whois";
      source: string;
      url: string;
      data: string;
      summary: Record<string, unknown>;
    }
  | { ok: false; error: string; tried: string[]; status?: number; hint: string };

async function runWhois(
  host: string,
  isIp: boolean,
  gateway: WhoisGateway,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<WhoisResult> {
  const plan = buildLookupPlan(host, isIp, gateway);
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
          return {
            ok: true,
            kind: "jpnic-whois",
            source: step.label,
            url: `whois://${JPNIC_WHOIS_HOST}/${host}`,
            data: text,
            summary: parsed,
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
        return {
          ok: true,
          kind: "rdap",
          source: step.label,
          url: step.url,
          data,
          summary: summarizeRdap(data),
        };
      } catch (error) {
        if (controller.signal.aborted) break;
        lastErr = {
          message: error instanceof Error ? error.message : String(error),
          label: step.label,
        };
      }
    }

    return {
      ok: false,
      error: lastErr?.message ?? "WHOIS/RDAP 全部源失败",
      tried,
      status: lastErr?.status,
      hint: "日本地址可试 gateway=jpnic；rdap.org 失败时会回退 JPNIC/APNIC/ARIN/RIPE",
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/* ------------------------------------------------------------------ *
 * Combined assessment
 * ------------------------------------------------------------------ */

type BgpSummary = ReturnType<typeof summarizeBgpView>;
type RdapSummary = ReturnType<typeof summarizeRdap>;

const STOP_WORDS = new Set([
  "the", "of", "and", "for", "co", "ltd", "llc", "inc", "corp", "corporation",
  "company", "group", "networks", "network", "communications", "communication",
  "telecom", "telecommunications", "internet", "services", "service", "japan",
  "jp", "technologies", "technology", "systems", "system", "holdings", "global",
]);

function nameTokens(value: string | undefined): string[] {
  if (!value) return [];
  return [
    ...new Set(
      value
        .toLowerCase()
        .replace(/[^a-z0-9\\u4e00-\\u9fff]+/g, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 3 && !STOP_WORDS.has(t))
    ),
  ];
}

function namesOverlap(a: string[], b: string[]): boolean {
  return a.some((x) =>
    b.some(
      (y) =>
        x === y ||
        (x.length >= 4 && y.length >= 4 && (x.startsWith(y) || y.startsWith(x)))
    )
  );
}

function rirOf(value: string | undefined): string | undefined {
  const v = (value ?? "").trim().toUpperCase();
  return /^(APNIC|ARIN|RIPE|AFRINIC|LACNIC)$/.test(v) ? v : undefined;
}

/** Maps a lookup-plan label to the RIR that owns the record. */
export function rirFromSource(source: string | undefined): string | undefined {
  const v = (source ?? "").toLowerCase();
  if (v.includes("jpnic") || v.includes("apnic")) return "APNIC";
  if (v.includes("arin")) return "ARIN";
  if (v.includes("ripe")) return "RIPE";
  if (v.includes("afrinic")) return "AFRINIC";
  if (v.includes("lacnic")) return "LACNIC";
  return undefined;
}

export type NetworkAssessment = {
  routeOwner?: string;
  networkOwner?: string;
  consistent?: boolean;
  notes: string[];
  hint: string;
};

/**
 * Cross-check BGP (who announces) against RDAP/WHOIS (who it is registered
 * to). Neither source is authoritative on its own: a customer-access prefix
 * announces through an ISP, and a hosting range is registered to the hoster.
 */
export function assessNetwork(input: {
  ip?: string;
  bgp?: BgpSummary;
  rdap?: RdapSummary;
  rdapSource?: string;
}): NetworkAssessment {
  const routeOwner =
    input.bgp?.asnName ?? input.bgp?.asnDescription ?? input.bgp?.prefixName;
  const networkOwner =
    input.rdap?.registrantName ?? input.rdap?.name ?? input.rdap?.handle;
  const notes: string[] = [];

  const a = nameTokens(routeOwner);
  const b = nameTokens(networkOwner);
  let consistent: boolean | undefined;
  if (a.length > 0 && b.length > 0) {
    consistent = namesOverlap(a, b);
    if (!consistent) {
      notes.push(
        "路由公告方与注册方名称不一致：可能为接入网、转售或托管，不能直接认定归属"
      );
    }
  }

  if (input.bgp?.classification === "customer_access") {
    notes.push("BGP 分类为 customer_access：网络所有者不等于终端使用机构");
  } else if (input.bgp?.classification === "infrastructure") {
    notes.push("BGP 分类为 infrastructure：更可能是基础设施/托管提供商");
  } else if (input.bgp?.classification === "transit_or_isp") {
    notes.push("BGP 分类为 transit_or_isp：优先 network_owner，慎下终端归属结论");
  }

  const bgpRir = rirOf(input.bgp?.rir);
  const rdapRir = rirFromSource(input.rdapSource);
  if (bgpRir && rdapRir && bgpRir !== rdapRir) {
    notes.push(`RIR 不一致：BGP rir_allocation=${bgpRir}，RDAP source=${input.rdapSource}`);
  }

  if (!input.bgp) {
    notes.push("缺少 BGP 数据：无法判断路由公告方与接入网/基础设施属性");
  }
  if (!input.rdap) {
    notes.push("缺少 RDAP/WHOIS 数据：无法确认注册方与 abuse 联系人");
  }

  let hint: string;
  if (input.bgp) {
    hint = bgpHint(input.bgp.classification);
  } else if (consistent === false) {
    hint = "路由与注册主体不一致，优先按接入网/托管研判";
  } else {
    hint = "信号有限，结合 PTR/被动DNS/HTTP 再研判";
  }

  return { routeOwner, networkOwner, consistent, notes, hint };
}

/* ------------------------------------------------------------------ *
 * Tool registration
 * ------------------------------------------------------------------ */

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "net_lookup",
    label: "Network Lookup",
    description:
      "网络归属查询。mode=auto（默认）IP 联合 BGP+RDAP、域名仅 RDAP；mode=bgp 查 ASN/前缀并区分接入网与基础设施；mode=whois 查 RDAP/WHOIS 注册信息（IP/域名，含 JPNIC）；mode=all 强制联合并交叉研判。",
    parameters: Type.Object({
      target: Type.Optional(Type.String({ description: "IP、域名或 URL" })),
      input: Type.Optional(Type.String({ description: "IP、域名或 URL" })),
      ip: Type.Optional(Type.String({ description: "IPv4 别名（bgp 模式）" })),
      mode: Type.Optional(
        Type.String({
          description: "auto（默认）| bgp | whois | all",
        })
      ),
      gateway: Type.Optional(
        Type.String({
          description: "whois 模式网关：auto|jpnic|apnic|arin|ripe|rdap，默认 auto",
        })
      ),
      raw: Type.Optional(
        Type.Boolean({
          description:
            "true 时返回原始数据（需明确 mode=bgp 或 mode=whois）",
        })
      ),
      timeout_seconds: Type.Optional(Type.Number({ description: "超时秒数，默认 20" })),
    }),
    async execute(_id, params, signal) {
      const rawInput = params.ip ?? params.target ?? params.input;
      if (!rawInput?.trim()) {
        return {
          content: [{ type: "text", text: "缺少 ip / target / input 参数" }],
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

      const requestedMode = normalizeMode(params.mode);
      if (!requestedMode) {
        return {
          content: [
            {
              type: "text",
              text: `不支持的 mode: ${params.mode}（可选 auto、bgp、whois、all）`,
            },
          ],
          details: {},
          isError: true,
        };
      }

      const mode = requestedMode === "auto" ? (isIp ? "all" : "whois") : requestedMode;
      const gateway = normalizeGateway(params.gateway);
      const timeoutMs = Math.max(3, params.timeout_seconds ?? 20) * 1000;
      const target = rawInput.trim();

      if (mode === "bgp") {
        if (!isIp || !IPV4.test(host)) {
          return {
            content: [{ type: "text", text: "bgp 模式仅支持 IPv4" }],
            details: {},
            isError: true,
          };
        }
        const result = await runBgp(host, timeoutMs, signal);
        if (!result.ok) {
          const err = {
            lookup: "bgp",
            error: true,
            message: result.error,
            host,
            url: result.url,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(err, null, 2) }],
            details: err,
            isError: true,
          };
        }
        const payload =
          params.raw === true
            ? {
                lookup: "bgp",
                target,
                host,
                ip: host,
                url: result.url,
                mode: "raw",
                provider: "bgpview",
                bgpview: result.data,
              }
            : {
                lookup: "bgp",
                target,
                url: result.url,
                mode: "summary",
                provider: "bgpview",
                ...result.summary,
              };
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          details: payload,
        };
      }

      if (mode === "whois") {
        const result = await runWhois(host, isIp, gateway, timeoutMs, signal);
        if (!result.ok) {
          const err = {
            lookup: "whois",
            error: true,
            message: result.error,
            host,
            gateway,
            tried: result.tried,
            lastStatus: result.status,
            hint: result.hint,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(err, null, 2) }],
            details: err,
            isError: true,
          };
        }
        const payload =
          params.raw === true
            ? {
                lookup: "whois",
                target,
                host,
                gateway,
                source: result.source,
                url: result.url,
                mode: "raw",
                ...(result.kind === "rdap"
                  ? { rdap: result.data }
                  : { whois: result.data }),
              }
            : {
                lookup: "whois",
                target,
                host,
                gateway,
                url: result.url,
                mode: "summary",
                ...result.summary,
                source: result.source,
              };
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          details: payload,
        };
      }

      // mode === "all"
      if (!isIp) {
        return {
          content: [
            { type: "text", text: "all 模式仅支持 IP；域名请用 mode=whois" },
          ],
          details: {},
          isError: true,
        };
      }
      if (params.raw === true) {
        return {
          content: [
            {
              type: "text",
              text: "raw=true 需要明确 mode=bgp 或 mode=whois（auto 在 IP 上会联合查询）",
            },
          ],
          details: {},
          isError: true,
        };
      }

      const ipv4 = IPV4.test(host);
      const bgpPromise: Promise<BgpResult> = ipv4
        ? runBgp(host, timeoutMs, signal)
        : Promise.resolve({
            ok: false as const,
            url: "",
            error: "BGPView 仅支持 IPv4，已跳过 BGP",
            skipped: true,
          });
      const [bgpResult, whoisResult] = await Promise.all([
        bgpPromise,
        runWhois(host, true, gateway, timeoutMs, signal),
      ]);

      const assessment = assessNetwork({
        ip: host,
        bgp: bgpResult.ok ? bgpResult.summary : undefined,
        rdap: whoisResult.ok ? whoisResult.summary : undefined,
        rdapSource: whoisResult.ok ? whoisResult.source : undefined,
      });

      const sources: Array<Record<string, unknown>> = [
        bgpResult.ok
          ? {
              provider: "bgpview",
              ok: true,
              url: bgpResult.url,
              asn: bgpResult.summary.asn,
              prefix: bgpResult.summary.prefix,
            }
          : {
              provider: "bgpview",
              ok: false,
              url: bgpResult.url || undefined,
              error: bgpResult.error,
              skipped: bgpResult.skipped || undefined,
            },
        whoisResult.ok
          ? {
              provider: "rdap",
              ok: true,
              source: whoisResult.source,
              url: whoisResult.url,
            }
          : {
              provider: "rdap",
              ok: false,
              error: whoisResult.error,
              tried: whoisResult.tried,
            },
      ];

      const payload = {
        lookup: "all",
        target,
        host,
        kind: "ip",
        route: bgpResult.ok ? bgpResult.summary : undefined,
        registration: whoisResult.ok ? whoisResult.summary : undefined,
        assessment,
        sources,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        details: payload,
        isError: !bgpResult.ok && !whoisResult.ok,
      };
    },
  });
}
