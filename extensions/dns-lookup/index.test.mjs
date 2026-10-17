/**
 * Tests for the dns_lookup extension's SecurityTrails key resolution.
 *
 * Run with: `node --test extensions/dns-lookup/index.test.mjs`
 *
 * Scope: the key lookup used by passive mode, which used to prefer the
 * REDTEAM_PASSIVE_DNS_KEY environment variable over settings.json and now
 * reads settings.json only.
 *
 * No network is touched — `loadSecurityTrailsKey` is config-only.
 *
 * JSDoc-typed harness; file stays `.mjs` so the runner can load it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSecurityTrailsKey } from "./index.ts";

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
