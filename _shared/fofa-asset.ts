/**
 * Shared asset / query helpers for the FOFA extensions.
 *
 * This module holds the *logic* only. It deliberately does not throw: the
 * callers (fofa_search, fofa_host, fofa_stats) each format their own error
 * messages, because those messages are shown to the model and are tailored to
 * what that particular tool asked for ("资产输入为空" reads wrong for a tool
 * whose parameter is called `host`). Keeping the throwing wrappers in the
 * extensions is what makes this refactor behaviour-neutral — the pure logic
 * moves, the user-visible strings do not.
 */

/** Matches a dotted-quad IPv4 literal. */
export const IPV4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

export interface ResolvedAsset {
  type: "ip" | "domain" | "url";
  host: string;
}

/**
 * Strip a `:port` suffix from a host, leaving bracketed IPv6 literals intact
 * (`[::1]:8080` → `[::1]`).
 */
export function stripPort(host: string): string {
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

/**
 * Classify and normalise a user-supplied asset (IP, domain, or URL) into a
 * bare host. Returns `null` for empty or unparseable input — callers decide
 * which error message that deserves.
 *
 * Note the asymmetry, pinned by tests: only literal IPs get `type: "ip"`;
 * URLs resolve to their hostname and are typed `"url"`, which still means a
 * follow-up query should use the `domain=` operator.
 */
export function parseAsset(input: string): ResolvedAsset | null {
  const raw = input.trim();
  if (!raw) return null;
  if (IPV4.test(raw)) return { type: "ip", host: raw };

  try {
    const withScheme = raw.includes("://") ? raw : `https://${raw}`;
    const url = new URL(withScheme);
    const host = stripPort(url.hostname);
    if (IPV4.test(host)) return { type: "ip", host };
    return { type: raw.includes("://") ? "url" : "domain", host };
  } catch {
    const host = stripPort(raw.split("/")[0] ?? raw);
    if (!host || host.includes(" ")) return null;
    return { type: "domain", host };
  }
}

/** Build the default FOFA query for an asset: IPs use `ip=`, everything else `domain=`. */
export function buildDefaultQuery(asset: ResolvedAsset): string {
  if (asset.type === "ip") return `ip="${asset.host}"`;
  return `domain="${asset.host}"`;
}
