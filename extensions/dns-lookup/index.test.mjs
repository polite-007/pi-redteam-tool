/**
 * Tests for the dns_lookup extension.
 *
 * Run with: `node --test extensions/dns-lookup/index.test.mjs`
 *
 * Covers the settings.json key lookup (the old REDTEAM_PASSIVE_DNS_KEY
 * environment variable is no longer read) plus the pure DoH/passive-source
 * helpers. Network calls in the integration tests are mocked.
 *
 * JSDoc-typed harness; file stays `.mjs` so the runner can load it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerDnsLookup, {
  loadSecurityTrailsKey,
  normalizePassiveSources,
  normalizeTransport,
  parseDohAnswers,
  parseOtxPassiveDns,
  parseWaybackHostnames,
  reverseName,
} from "./index.ts";
import { resolveDohEndpoint } from "../../_shared/doh.ts";

/* ------------------------------------------------------------------ *
 * environment helpers
 * ------------------------------------------------------------------ */

const ENV_KEYS = [
  "REDTEAM_PASSIVE_DNS_KEY",
  "PI_SETTINGS_PATH",
];

/**
 * A path that cannot exist. Pinned unless a test supplies its own file, so no
 * test can read the developer's real ~/.pi/agent/settings.json and pass or
 * fail depending on the machine it runs on.
 */
const NO_SETTINGS_FILE = join(tmpdir(), "dns-must-not-be-read.json");

/**
 * Clear the dns env vars, run `body` against a settings file, then
 * always restore — deleting vars that were absent to begin with, since
 * assigning `undefined` would leave the literal string "undefined" behind.
 *
 * `settings` is written to a temp file and pinned via PI_SETTINGS_PATH; pass
 * `null` for "no settings file at all".
 */
function withSettings(body, settings = null) {
  const saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }

  const dir = settings === null ? null : mkdtempSync(join(tmpdir(), "dns-settings-"));
  const file = dir === null ? NO_SETTINGS_FILE : join(dir, "settings.json");
  if (dir !== null) writeFileSync(file, settings, "utf8");
  process.env.PI_SETTINGS_PATH = file;

  try {
    body();
  } finally {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

/** Shorthand: a settings file containing just the given dns-lookup block. */
function withDnsLookup(body, dnsLookup) {
  withSettings(body, JSON.stringify({ redteam: { "dns-lookup": dnsLookup } }));
}

/* ------------------------------------------------------------------ *
 * loadSecurityTrailsKey
 * ------------------------------------------------------------------ */

test("loadSecurityTrailsKey: undefined when no settings file exists", () => {
  withSettings(() => {
    assert.equal(loadSecurityTrailsKey(), undefined);
  });
});

test("loadSecurityTrailsKey: reads redteam.dns-lookup.securityTrailsKey", () => {
  withDnsLookup(() => {
    assert.equal(loadSecurityTrailsKey(), "st-key");
  }, { securityTrailsKey: "st-key" });
});

test("loadSecurityTrailsKey: trims the key", () => {
  withDnsLookup(() => {
    assert.equal(loadSecurityTrailsKey(), "st-key");
  }, { securityTrailsKey: "  st-key  " });
});

test("loadSecurityTrailsKey: a blank or non-string key is not configuration", () => {
  withDnsLookup(() => assert.equal(loadSecurityTrailsKey(), undefined), {
    securityTrailsKey: "   ",
  });
  withDnsLookup(() => assert.equal(loadSecurityTrailsKey(), undefined), {
    securityTrailsKey: 12345,
  });
});

test("loadSecurityTrailsKey: the old redteam.passiveDns section is ignored", () => {
  withSettings(() => {
    assert.equal(loadSecurityTrailsKey(), undefined);
  }, JSON.stringify({ redteam: { passiveDns: { securityTrailsKey: "old-key" } } }));
});

test("loadSecurityTrailsKey: ignores REDTEAM_PASSIVE_DNS_KEY", () => {
  // The regression this change exists for: the env var used to win over the
  // settings file, and to be used when the file had nothing.
  withDnsLookup(() => {
    process.env.REDTEAM_PASSIVE_DNS_KEY = "from-env";
    assert.equal(loadSecurityTrailsKey(), "from-settings");
  }, { securityTrailsKey: "from-settings" });

  withSettings(() => {
    process.env.REDTEAM_PASSIVE_DNS_KEY = "from-env";
    assert.equal(loadSecurityTrailsKey(), undefined, "an env-only key is not configuration");
  });
});

test("loadSecurityTrailsKey: a malformed settings file degrades to undefined", () => {
  withSettings(() => {
    assert.equal(loadSecurityTrailsKey(), undefined);
  }, "{ not json");
});

test("loadSecurityTrailsKey: a FOFA-only config does not leak a SecurityTrails key", () => {
  withSettings(() => {
    assert.equal(loadSecurityTrailsKey(), undefined);
  }, JSON.stringify({ redteam: { fofa: { key: "fofa-key" } } }));
});

/* ------------------------------------------------------------------ *
 * records transport / DoH helpers
 * ------------------------------------------------------------------ */

test("normalizeTransport: defaults to auto and accepts aliases", () => {
  assert.equal(normalizeTransport(undefined), "auto");
  assert.equal(normalizeTransport("AUTO"), "auto");
  assert.equal(normalizeTransport("system"), "system");
  assert.equal(normalizeTransport("dns"), "system");
  assert.equal(normalizeTransport("doh"), "doh");
  assert.equal(normalizeTransport("https"), "doh");
  assert.equal(normalizeTransport("nope"), undefined);
});

test("resolveDohEndpoint: presets, auto, URL and invalid input", () => {
  assert.deepEqual(resolveDohEndpoint("google").endpoints, [
    "https://dns.google/resolve",
  ]);
  assert.equal(resolveDohEndpoint(undefined).endpoints.length, 4);
  assert.deepEqual(resolveDohEndpoint("https://doh.example/resolve").endpoints, [
    "https://doh.example/resolve",
  ]);
  assert.match(resolveDohEndpoint("nope").error, /未知 DoH 服务器/);
});

test("reverseName: IPv4 and IPv6 PTR names", () => {
  assert.equal(reverseName("8.8.8.8"), "8.8.8.8.in-addr.arpa");
  assert.equal(
    reverseName("2001:db8::1"),
    reverseName("2001:db8:0:0:0:0:0:1")
  );
  assert.match(reverseName("2001:db8::1"), /8\.b\.d\.0\.1\.0\.0\.2\.ip6\.arpa$/);
});

test("parseDohAnswers: normalizes records to system-resolver shapes", () => {
  const answers = [
    { name: "example.com.", type: 1, ttl: 60, data: "1.2.3.4" },
    { name: "example.com.", type: 15, ttl: 60, data: "10 mail.example.com." },
    { name: "example.com.", type: 16, ttl: 60, data: '"v=spf1 -all"' },
    {
      name: "example.com.",
      type: 6,
      ttl: 60,
      data: "ns1.example.com. hostmaster.example.com. 1 7200 3600 1209600 3600",
    },
    { name: "_sip._tcp.example.com.", type: 33, ttl: 60, data: "0 5 5060 sip.example.com." },
    { name: "example.com.", type: 257, ttl: 60, data: '0 issue "letsencrypt.org"' },
  ];

  assert.deepEqual(parseDohAnswers("A", answers), ["1.2.3.4"]);
  assert.deepEqual(parseDohAnswers("MX", answers), [
    { priority: 10, exchange: "mail.example.com" },
  ]);
  assert.deepEqual(parseDohAnswers("TXT", answers), ["v=spf1 -all"]);
  assert.deepEqual(parseDohAnswers("SOA", answers), [
    {
      nsname: "ns1.example.com",
      hostmaster: "hostmaster.example.com",
      serial: 1,
      refresh: 7200,
      retry: 3600,
      expire: 1209600,
      minttl: 3600,
    },
  ]);
  assert.deepEqual(parseDohAnswers("SRV", answers), [
    { priority: 0, weight: 5, port: 5060, name: "sip.example.com" },
  ]);
  assert.deepEqual(parseDohAnswers("CAA", answers), [
    { critical: 0, issue: "letsencrypt.org" },
  ]);
});

/* ------------------------------------------------------------------ *
 * passive sources
 * ------------------------------------------------------------------ */

test("normalizePassiveSources: kind-aware defaults and explicit lists", () => {
  assert.deepEqual(normalizePassiveSources(undefined, "domain"), ["crt.sh", "wayback"]);
  assert.deepEqual(normalizePassiveSources(undefined, "ip"), ["crt.sh", "otx"]);
  assert.deepEqual(normalizePassiveSources(["otx"], "domain"), ["otx"]);
  assert.deepEqual(normalizePassiveSources("crt.sh, wayback", "ip"), ["crt.sh", "wayback"]);
  assert.deepEqual(normalizePassiveSources(["all"], "domain"), [
    "crt.sh",
    "otx",
    "wayback",
  ]);
  assert.deepEqual(normalizePassiveSources(["unknown"], "ip"), ["crt.sh", "otx"]);
});

test("parseOtxPassiveDns: extracts, dedupes and sorts hostnames", () => {
  assert.deepEqual(
    parseOtxPassiveDns({
      passive_dns: [
        { hostname: "b.example.com" },
        { hostname: "*.a.example.com" },
        { hostname: "b.example.com" },
        { hostname: "" },
      ],
    }),
    ["a.example.com", "b.example.com"]
  );
  assert.deepEqual(parseOtxPassiveDns({ detail: "auth required" }), []);
});

test("parseWaybackHostnames: keeps only in-scope hosts", () => {
  assert.deepEqual(
    parseWaybackHostnames(
      [
        ["original"],
        ["https://a.example.com/x"],
        ["http://b.example.com:8080/y"],
        ["https://other.com/z"],
      ],
      "example.com"
    ),
    ["a.example.com", "b.example.com"]
  );
});

/* ------------------------------------------------------------------ *
 * tool integration (fetch mocked)
 * ------------------------------------------------------------------ */

function registeredTool() {
  let tool;
  registerDnsLookup({ registerTool: (t) => (tool = t) });
  return tool;
}

test("tool: transport=doh returns records and DNSSEC status", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /type=A/);
    return new Response(
      JSON.stringify({
        Status: 0,
        AD: true,
        Answer: [{ name: "example.com.", type: 1, TTL: 60, data: "93.184.216.34" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const tool = registeredTool();
    const result = await tool.execute(
      "1",
      { target: "example.com", types: ["A"], transport: "doh" },
      undefined
    );

    assert.equal(result.isError, false);
    assert.equal(result.details.transport, "doh");
    assert.deepEqual(result.details.records.A, ["93.184.216.34"]);
    assert.equal(result.details.dnssec.authenticated, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("tool: passive sources can be selected explicitly", async () => {
  const originalFetch = globalThis.fetch;

  try {
    const tool = registeredTool();

    globalThis.fetch = async (url) => {
      assert.match(String(url), /alienvault/);
      return new Response(
        JSON.stringify({
          passive_dns: [
            { hostname: "a.example.com" },
            { hostname: "b.example.com" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };
    const otx = await tool.execute(
      "1",
      { target: "example.com", mode: "passive", sources: ["otx"], limit: 10 },
      undefined
    );
    assert.equal(otx.isError, false);
    assert.deepEqual(otx.details.domains, ["a.example.com", "b.example.com"]);

    globalThis.fetch = async () => new Response(
      JSON.stringify([
        ["original"],
        ["https://a.example.com/x"],
        ["http://c.example.com:8080/y"],
      ]),
      { status: 200, headers: { "content-type": "application/json" } }
    );
    const wayback = await tool.execute(
      "2",
      { target: "example.com", mode: "passive", sources: ["wayback"], limit: 10 },
      undefined
    );
    assert.equal(wayback.isError, false);
    assert.deepEqual(wayback.details.domains, ["a.example.com", "c.example.com"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
