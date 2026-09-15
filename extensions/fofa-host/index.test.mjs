/**
 * Tests for the fofa_host extension's pure helpers.
 *
 * Run with: `node --test extensions/fofa-host/index.test.mjs`
 *
 * Companion to `extensions/fofa-search/index.test.mjs`. `resolveHost` and
 * `loadFofaConfig` were near-copies of the fofa-search versions; both tools
 * now delegate to `_shared/`. These tests pin the behaviour they rely on.
 *
 * Scope note: the `resolveHost` tests ran against the pre-refactor code.
 * The `loadFofaConfig` tests did not — it was module-private before this
 * change and had to be exported (a no-op for behaviour) before it was
 * testable at all.
 *
 * JSDoc-typed harness; file stays `.mjs` so the runner can load it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFofaConfig, resolveHost } from "./index.ts";

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
 * A path that is guaranteed not to exist. Pinned by every test unless it
 * supplies its own file, so no test can accidentally read the developer's
 * real ~/.pi/agent/settings.json.
 */
const NO_SETTINGS_FILE = join(tmpdir(), "fofa-host-must-not-be-read.json");

/** Snapshot FOFA env vars, run `body`, then always restore. */
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

/** Write `content` to a temp settings file and return its path + dir. */
function tempSettings(content) {
  const dir = mkdtempSync(join(tmpdir(), "fofa-host-settings-"));
  const file = join(dir, "settings.json");
  writeFileSync(file, content, "utf8");
  return { file, dir };
}

/* ------------------------------------------------------------------ *
 * resolveHost — the host API wants a bare host, never a URL
 * ------------------------------------------------------------------ */

test("resolveHost: bare IPv4 passes through", () => {
  assert.equal(resolveHost("1.2.3.4"), "1.2.3.4");
  assert.equal(resolveHost("  1.2.3.4  "), "1.2.3.4");
});

test("resolveHost: bare domain passes through", () => {
  assert.equal(resolveHost("example.com"), "example.com");
});

test("resolveHost: a URL is reduced to its hostname", () => {
  assert.equal(resolveHost("https://example.com/some/path?q=1"), "example.com");
  assert.equal(resolveHost("http://sub.example.com"), "sub.example.com");
});

test("resolveHost: ports are stripped from hosts and URLs", () => {
  assert.equal(resolveHost("example.com:8080"), "example.com");
  assert.equal(resolveHost("https://example.com:8443/x"), "example.com");
  assert.equal(resolveHost("1.2.3.4:80"), "1.2.3.4");
});

test("resolveHost: a URL pointing at an IP yields the IP", () => {
  assert.equal(resolveHost("http://1.2.3.4:8080/x"), "1.2.3.4");
});

test("resolveHost: bracketed IPv6 literals keep their brackets", () => {
  assert.equal(resolveHost("[::1]:8080"), "[::1]");
});

test("resolveHost: a schemeless path-ish input resolves to its host", () => {
  assert.equal(resolveHost("example.com/path"), "example.com");
});

test("resolveHost: rejects empty input", () => {
  assert.throws(() => resolveHost(""), /缺少 host \/ target \/ input/);
  assert.throws(() => resolveHost("   "), /缺少 host \/ target \/ input/);
});

test("resolveHost: rejects unparseable input containing whitespace", () => {
  assert.throws(() => resolveHost("not a host with spaces"), /无法解析 host/);
});

/* ------------------------------------------------------------------ *
 * loadFofaConfig — the copy that lives in this extension
 * ------------------------------------------------------------------ */

test("loadFofaConfig: env vars win over settings.json", () => {
  withEnv(() => {
    const { file, dir } = tempSettings(
      JSON.stringify({ redteam: { fofa: { key: "from-settings" } } }),
    );
    try {
      process.env.REDTEAM_FOFA_KEY = "from-env";
      process.env.PI_SETTINGS_PATH = file;

      assert.deepEqual(loadFofaConfig(), {
        key: "from-env",
        email: undefined,
        baseUrl: "https://fofa.info",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("loadFofaConfig: falls back to settings.json", () => {
  withEnv(() => {
    const { file, dir } = tempSettings(
      JSON.stringify({ redteam: { fofa: { key: "from-settings" } } }),
    );
    try {
      process.env.PI_SETTINGS_PATH = file;
      assert.equal(loadFofaConfig()?.key, "from-settings");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("loadFofaConfig: returns null when no source has a key", () => {
  withEnv(() => {
    assert.equal(loadFofaConfig(), null);
  });
});

test("loadFofaConfig: swallows malformed settings.json", () => {
  withEnv(() => {
    const { file, dir } = tempSettings("{ not json");
    try {
      process.env.PI_SETTINGS_PATH = file;
      assert.equal(loadFofaConfig(), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ *
 * tool registration
 * ------------------------------------------------------------------ */

test("registers fofa_host with the expected metadata", async () => {
  const { default: register } = await import("./index.ts");
  /** @type {{name: string, description: string, parameters: unknown} | null} */
  let captured = null;
  register(
    /** @type {never} */ ({
      registerTool(tool) {
        captured = tool;
      },
    }),
  );
  assert.ok(captured, "registerTool was never called");
  assert.equal(captured.name, "fofa_host");
  assert.equal(typeof captured.description, "string");
  assert.ok(captured.description.length > 0);
  assert.equal(typeof captured.parameters, "object");
});
