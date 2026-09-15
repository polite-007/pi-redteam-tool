/**
 * Tests for the fofa_search extension's pure helpers.
 *
 * Run with: `node --test extensions/fofa-search/index.test.mjs`
 *
 * These pin the behaviour of the helpers that the shared-config refactor
 * moved into `_shared/`, so the move can be shown to have changed nothing.
 *
 * Scope note, so nobody over-reads this file: the `resolveAsset` /
 * `buildDefaultQuery` / `resolveFields` / `capSize` / `rowsToObjects` tests ran
 * against the pre-refactor code as-is. The `loadFofaConfig` tests did not —
 * that function was module-private before this change, so it had to be
 * exported (a no-op for behaviour) before it was testable at all. Both halves
 * are re-run against the shared implementation.
 *
 * No network is touched — every helper under test is pure or config-only.
 *
 * JSDoc-typed harness; file stays `.mjs` so the runner can load it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FOFA_FIELDS_DEFAULT,
  FOFA_FIELDS_LIGHT,
  buildDefaultQuery,
  capSize,
  loadFofaConfig,
  maskKey,
  resolveAsset,
  resolveFields,
  rowsToObjects,
} from "./index.ts";

/* ------------------------------------------------------------------ *
 * environment helpers
 * ------------------------------------------------------------------ */

const FOFA_ENV_KEYS = [
  "REDTEAM_FOFA_KEY",
  "REDTEAM_FOFA_EMAIL",
  "REDTEAM_FOFA_BASE_URL",
  "PI_SETTINGS_PATH",
];

/**
 * A path that is guaranteed not to exist. Every test pins PI_SETTINGS_PATH to
 * this unless it deliberately supplies its own file, so that no test can
 * accidentally read the developer's real ~/.pi/agent/settings.json — doing so
 * would make the suite pass or fail based on the machine it runs on.
 */
const NO_SETTINGS_FILE = join(tmpdir(), "fofa-settings-must-not-be-read.json");

/**
 * Snapshot the FOFA-related env vars, hand control to `body`, and always
 * restore — including deleting vars that were absent to begin with, since
 * assigning `undefined` would leave the literal string "undefined" behind.
 */
function withEnv(body) {
  const saved = {};
  for (const key of FOFA_ENV_KEYS) saved[key] = process.env[key];
  for (const key of FOFA_ENV_KEYS) delete process.env[key];
  process.env.PI_SETTINGS_PATH = NO_SETTINGS_FILE;
  try {
    body();
  } finally {
    for (const key of FOFA_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

/** Write `content` to a temp file and return its path. */
function tempSettings(content) {
  const dir = mkdtempSync(join(tmpdir(), "fofa-settings-"));
  const file = join(dir, "settings.json");
  writeFileSync(file, content, "utf8");
  return { file, dir };
}

/* ------------------------------------------------------------------ *
 * loadFofaConfig — env > settings.json, with fallbacks
 * ------------------------------------------------------------------ */

test("loadFofaConfig: env vars win over settings.json", () => {
  withEnv(() => {
    const { file, dir } = tempSettings(
      JSON.stringify({ redteam: { fofa: { key: "from-settings" } } }),
    );
    try {
      process.env.REDTEAM_FOFA_KEY = "from-env";
      process.env.REDTEAM_FOFA_EMAIL = "env@example.com";
      process.env.PI_SETTINGS_PATH = file;

      const cfg = loadFofaConfig();
      assert.deepEqual(cfg, {
        key: "from-env",
        email: "env@example.com",
        baseUrl: "https://fofa.info",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("loadFofaConfig: falls back to settings.json when env key is absent", () => {
  withEnv(() => {
    const { file, dir } = tempSettings(
      JSON.stringify({
        redteam: { fofa: { key: "from-settings", email: "s@example.com" } },
      }),
    );
    try {
      process.env.PI_SETTINGS_PATH = file;

      assert.deepEqual(loadFofaConfig(), {
        key: "from-settings",
        email: "s@example.com",
        baseUrl: "https://fofa.info",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("loadFofaConfig: a whitespace-only env key is treated as absent", () => {
  withEnv(() => {
    const { file, dir } = tempSettings(
      JSON.stringify({ redteam: { fofa: { key: "from-settings" } } }),
    );
    try {
      process.env.REDTEAM_FOFA_KEY = "   ";
      process.env.PI_SETTINGS_PATH = file;

      assert.equal(loadFofaConfig()?.key, "from-settings");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("loadFofaConfig: honours a custom base url from env and from settings", () => {
  withEnv(() => {
    process.env.REDTEAM_FOFA_KEY = "k";
    process.env.REDTEAM_FOFA_BASE_URL = "https://mirror.example";
    assert.equal(loadFofaConfig()?.baseUrl, "https://mirror.example");
  });

  withEnv(() => {
    const { file, dir } = tempSettings(
      JSON.stringify({
        redteam: { fofa: { key: "k", baseUrl: "https://mirror.example" } },
      }),
    );
    try {
      process.env.PI_SETTINGS_PATH = file;
      assert.equal(loadFofaConfig()?.baseUrl, "https://mirror.example");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("loadFofaConfig: omits email when neither source provides one", () => {
  withEnv(() => {
    process.env.REDTEAM_FOFA_KEY = "k";
    const cfg = loadFofaConfig();
    assert.equal(cfg?.key, "k");
    assert.equal(cfg?.email, undefined);
  });
});

test("loadFofaConfig: returns null when no source has a key", () => {
  withEnv(() => {
    assert.equal(loadFofaConfig(), null);
  });
});

test("loadFofaConfig: returns null when the settings file is missing", () => {
  withEnv(() => {
    process.env.PI_SETTINGS_PATH = join(tmpdir(), "definitely-not-here-12345.json");
    assert.equal(loadFofaConfig(), null);
  });
});

test("loadFofaConfig: swallows malformed settings.json instead of throwing", () => {
  withEnv(() => {
    const { file, dir } = tempSettings("{ this is not json ");
    try {
      process.env.PI_SETTINGS_PATH = file;
      assert.equal(loadFofaConfig(), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("loadFofaConfig: returns null when settings.json lacks redteam.fofa.key", () => {
  withEnv(() => {
    const { file, dir } = tempSettings(
      JSON.stringify({ redteam: { fofa: { email: "only@example.com" } } }),
    );
    try {
      process.env.PI_SETTINGS_PATH = file;
      assert.equal(loadFofaConfig(), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ *
 * resolveAsset
 * ------------------------------------------------------------------ */

test("resolveAsset: bare IPv4 is classified as an ip", () => {
  assert.deepEqual(resolveAsset("1.2.3.4"), { type: "ip", host: "1.2.3.4" });
  assert.deepEqual(resolveAsset("  1.2.3.4  "), { type: "ip", host: "1.2.3.4" });
});

test("resolveAsset: bare domain is classified as a domain", () => {
  assert.deepEqual(resolveAsset("example.com"), {
    type: "domain",
    host: "example.com",
  });
});

test("resolveAsset: a domain with a port keeps the host and drops the port", () => {
  assert.deepEqual(resolveAsset("example.com:8080"), {
    type: "domain",
    host: "example.com",
  });
});

test("resolveAsset: an IPv4 with a port is still an ip", () => {
  assert.deepEqual(resolveAsset("1.2.3.4:8443"), { type: "ip", host: "1.2.3.4" });
});

test("resolveAsset: a URL keeps host only and is classified as a url", () => {
  assert.deepEqual(resolveAsset("https://example.com/some/path?q=1"), {
    type: "url",
    host: "example.com",
  });
});

test("resolveAsset: a URL pointing at an IP is classified as an ip", () => {
  assert.deepEqual(resolveAsset("http://1.2.3.4:8080/x"), {
    type: "ip",
    host: "1.2.3.4",
  });
});

test("resolveAsset: a schemeless path-ish input resolves to its host", () => {
  assert.deepEqual(resolveAsset("example.com/path"), {
    type: "domain",
    host: "example.com",
  });
});

test("resolveAsset: bracketed IPv6 literals survive port stripping", () => {
  assert.deepEqual(resolveAsset("[::1]:8080"), {
    type: "domain",
    host: "[::1]",
  });
});

test("resolveAsset: rejects empty input", () => {
  assert.throws(() => resolveAsset(""), /资产输入为空/);
  assert.throws(() => resolveAsset("   "), /资产输入为空/);
});

test("resolveAsset: rejects unparseable input containing whitespace", () => {
  assert.throws(() => resolveAsset("not a url with spaces"), /无法解析资产/);
});

/* ------------------------------------------------------------------ *
 * buildDefaultQuery
 * ------------------------------------------------------------------ */

test("buildDefaultQuery: ip assets use the ip= operator", () => {
  assert.equal(buildDefaultQuery({ type: "ip", host: "1.2.3.4" }), 'ip="1.2.3.4"');
});

test("buildDefaultQuery: domain assets use the domain= operator", () => {
  assert.equal(
    buildDefaultQuery({ type: "domain", host: "example.com" }),
    'domain="example.com"',
  );
});

test("buildDefaultQuery: url assets also fall back to the domain= operator", () => {
  // Pinning this asymmetry deliberately: only "ip" gets the ip= branch.
  assert.equal(
    buildDefaultQuery({ type: "url", host: "example.com" }),
    'domain="example.com"',
  );
});

/* ------------------------------------------------------------------ *
 * resolveFields
 * ------------------------------------------------------------------ */

test("resolveFields: an explicit list is trimmed and normalised", () => {
  assert.equal(resolveFields({ fields: " ip , port ,, country " }), "ip,port,country");
});

test("resolveFields: blank fields fall through to the preset", () => {
  assert.equal(resolveFields({ fields: "   ", preset: "light" }), FOFA_FIELDS_LIGHT);
});

test("resolveFields: defaults to the official field set", () => {
  assert.equal(resolveFields({}), FOFA_FIELDS_DEFAULT);
  assert.equal(resolveFields({ preset: "default" }), FOFA_FIELDS_DEFAULT);
});

test("resolveFields: preset names are case-insensitive", () => {
  assert.equal(resolveFields({ preset: "LIGHT" }), FOFA_FIELDS_LIGHT);
  assert.equal(resolveFields({ preset: "Full" }), FOFA_FIELDS_DEFAULT);
});

test("resolveFields: an unknown preset falls back to the default set", () => {
  assert.equal(resolveFields({ preset: "nonsense" }), FOFA_FIELDS_DEFAULT);
});

test("resolveFields: light drops the raw cert/banner/header columns", () => {
  // Note: LIGHT still carries the derived cert.* columns, so a plain
  // substring check for "cert" would be wrong — compare exact columns.
  const light = FOFA_FIELDS_LIGHT.split(",");
  const full = FOFA_FIELDS_DEFAULT.split(",");
  for (const heavy of ["cert", "banner", "header"]) {
    assert.ok(!light.includes(heavy), `light should drop ${heavy}`);
    assert.ok(full.includes(heavy), `default should keep ${heavy}`);
  }
});

/* ------------------------------------------------------------------ *
 * capSize
 * ------------------------------------------------------------------ */

test("capSize: defaults to 20 and never exceeds 100", () => {
  assert.equal(capSize("ip,port"), 20);
  assert.equal(capSize("ip,port", 500), 100);
});

test("capSize: clamps to at least 1", () => {
  assert.equal(capSize("ip,port", 0), 1);
  assert.equal(capSize("ip,port", -5), 1);
});

test("capSize: heavy fields (banner/header/cert) cap at 50", () => {
  assert.equal(capSize("ip,banner", 100), 50);
  assert.equal(capSize("ip,cert", 100), 50);
  assert.equal(capSize("ip,port", 100), 100);
});

test("capSize: body caps at 20 even when 50 would be allowed", () => {
  assert.equal(capSize("ip,body", 100), 20);
  assert.equal(capSize("ip,body", 5), 5);
});

test("capSize: the default field set counts as heavy", () => {
  assert.equal(capSize(FOFA_FIELDS_DEFAULT, 100), 50);
});

test("capSize: the light preset is ALSO treated as heavy, via the cert.* columns", () => {
  // Pinned deliberately, and it is a latent inconsistency worth knowing about:
  // FOFA_FIELDS_LIGHT drops the raw `cert`/`banner`/`header` columns to save
  // F-points, but it keeps cert.issuer.* / cert.subject.* / cert.sn — and the
  // heavy-field regex `\b(banner|header|body|cert)\b` matches `cert` inside
  // "cert.issuer.org" (there is a word boundary at the dot). So `light` still
  // gets the 50 cap rather than 100. Recorded as current behaviour so the
  // shared-config refactor cannot change it silently.
  assert.equal(capSize(FOFA_FIELDS_LIGHT, 100), 50);
});

/* ------------------------------------------------------------------ *
 * rowsToObjects
 * ------------------------------------------------------------------ */

test("rowsToObjects: missing or empty rows produce no records", () => {
  assert.deepEqual(rowsToObjects("ip,port", undefined), []);
  assert.deepEqual(rowsToObjects("ip,port", []), []);
});

test("rowsToObjects: maps positional rows onto field names", () => {
  assert.deepEqual(rowsToObjects("ip,port,country", [["1.2.3.4", "80", "CN"]]), [
    { ip: "1.2.3.4", port: "80", country: "CN" },
  ]);
});

test("rowsToObjects: absent trailing values become empty strings", () => {
  assert.deepEqual(rowsToObjects("ip,port,country", [["1.2.3.4"]]), [
    { ip: "1.2.3.4", port: "", country: "" },
  ]);
});

test("rowsToObjects: trims whitespace around field names", () => {
  assert.deepEqual(rowsToObjects(" ip , port ", [["1.2.3.4", "80"]]), [
    { ip: "1.2.3.4", port: "80" },
  ]);
});

test("rowsToObjects: strips certificate noise and collapses blank lines", () => {
  const cert = [
    "-----BEGIN CERTIFICATE-----",
    "MIIB",
    "Signature Algorithm: sha256WithRSAEncryption",
    "Timestamp : Jan  1 00:00:00 2024 GMT",
    "-----END CERTIFICATE-----",
  ].join("\n");
  const [row] = rowsToObjects("cert", [[cert]]);
  assert.ok(!row.cert.includes("Signature Algorithm"));
  assert.ok(!row.cert.includes("Timestamp"));
  assert.ok(row.cert.includes("MIIB"));
  assert.ok(!row.cert.includes("\n\n"));
});

test("rowsToObjects: truncates long banner/header/body values to 400 chars", () => {
  const long = "A".repeat(1000);
  for (const field of ["banner", "header", "body"]) {
    const [row] = rowsToObjects(field, [[long]]);
    assert.equal(row[field].length, 401, `${field} should be truncated`);
    assert.ok(row[field].endsWith("…"));
  }
});

test("rowsToObjects: leaves other long fields untruncated", () => {
  const long = "A".repeat(1000);
  const [row] = rowsToObjects("title", [[long]]);
  assert.equal(row.title.length, 1000);
});

/* ------------------------------------------------------------------ *
 * maskKey
 * ------------------------------------------------------------------ */

test("maskKey: fully masks short keys", () => {
  assert.equal(maskKey("12345678"), "****");
  assert.equal(maskKey("abc"), "****");
});

test("maskKey: reveals only the outer four characters of long keys", () => {
  assert.equal(maskKey("1234567890"), "1234****7890");
});
