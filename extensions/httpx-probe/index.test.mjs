/**
 * Tests for the httpx_probe extension's configuration resolution.
 *
 * Run with: `node --test extensions/httpx-probe/index.test.mjs`
 *
 * Scope: the binary/proxy lookups that used to prefer `REDTEAM_HTTPX_*`
 * environment variables and now read settings.json only. These are also the
 * closest thing the shared `_shared/settings.ts` loader has to a direct test —
 * the malformed / wrong-type / non-object cases below exercise it through a
 * real caller.
 *
 * No network, no child processes: only the config resolvers are touched.
 *
 * JSDoc-typed harness; file stays `.mjs` so the runner can load it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHttpxBinary, resolveHttpxProxy } from "./index.ts";

/* ------------------------------------------------------------------ *
 * environment helpers
 * ------------------------------------------------------------------ */

const ENV_KEYS = ["REDTEAM_HTTPX_BINARY", "REDTEAM_HTTPX_PROXY", "PI_SETTINGS_PATH"];

/**
 * A path that cannot exist. Pinned unless a test supplies its own file, so no
 * test can read the developer's real ~/.pi/agent/settings.json and pass or
 * fail depending on the machine it runs on.
 */
const NO_SETTINGS_FILE = join(tmpdir(), "httpx-must-not-be-read.json");

/**
 * Clear the httpx env vars, run `body` against a settings file, then always
 * restore — deleting vars that were absent to begin with, since assigning
 * `undefined` would leave the literal string "undefined" behind.
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

  const dir = settings === null ? null : mkdtempSync(join(tmpdir(), "httpx-settings-"));
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

/** Shorthand: a settings file containing just the given httpx block. */
function withHttpx(body, httpx) {
  withSettings(body, JSON.stringify({ redteam: { httpx } }));
}

/* ------------------------------------------------------------------ *
 * resolveHttpxBinary
 * ------------------------------------------------------------------ */

test("resolveHttpxBinary: falls back to PATH lookup when unconfigured", () => {
  withSettings(() => {
    assert.equal(resolveHttpxBinary(), "httpx");
  });
});

test("resolveHttpxBinary: reads redteam.httpx.binary", () => {
  withHttpx(() => {
    assert.equal(resolveHttpxBinary(), "/opt/bin/httpx");
  }, { binary: "/opt/bin/httpx" });
});

test("resolveHttpxBinary: a blank or non-string binary falls back to PATH", () => {
  withHttpx(() => assert.equal(resolveHttpxBinary(), "httpx"), { binary: "   " });
  withHttpx(() => assert.equal(resolveHttpxBinary(), "httpx"), { binary: 42 });
});

test("resolveHttpxBinary: ignores REDTEAM_HTTPX_BINARY", () => {
  // The regression this change exists for: the env var used to win over the
  // settings file, and to be used when the file had nothing.
  withHttpx(() => {
    process.env.REDTEAM_HTTPX_BINARY = "/from/env";
    assert.equal(resolveHttpxBinary(), "/opt/bin/httpx");
  }, { binary: "/opt/bin/httpx" });

  withSettings(() => {
    process.env.REDTEAM_HTTPX_BINARY = "/from/env";
    assert.equal(resolveHttpxBinary(), "httpx", "an env-only binary is not configuration");
  });
});

/* ------------------------------------------------------------------ *
 * resolveHttpxProxy
 * ------------------------------------------------------------------ */

test("resolveHttpxProxy: undefined when unconfigured", () => {
  withSettings(() => {
    assert.equal(resolveHttpxProxy(), undefined);
  });
  withHttpx(() => assert.equal(resolveHttpxProxy(), undefined), {});
});

test("resolveHttpxProxy: reads redteam.httpx.proxy", () => {
  withHttpx(() => {
    assert.equal(resolveHttpxProxy(), "socks5://127.0.0.1:1080");
  }, { proxy: "socks5://127.0.0.1:1080" });
});

test("resolveHttpxProxy: trims, and treats a blank proxy as unconfigured", () => {
  withHttpx(() => assert.equal(resolveHttpxProxy(), "http://p:8080"), {
    proxy: "  http://p:8080  ",
  });
  withHttpx(() => assert.equal(resolveHttpxProxy(), undefined), { proxy: "   " });
});

test("resolveHttpxProxy: ignores REDTEAM_HTTPX_PROXY", () => {
  withHttpx(() => {
    process.env.REDTEAM_HTTPX_PROXY = "http://from-env:8080";
    assert.equal(resolveHttpxProxy(), "http://from-settings:8080");
  }, { proxy: "http://from-settings:8080" });

  withSettings(() => {
    process.env.REDTEAM_HTTPX_PROXY = "http://from-env:8080";
    assert.equal(resolveHttpxProxy(), undefined);
  });
});

/* ------------------------------------------------------------------ *
 * unreadable / unusable settings files
 * ------------------------------------------------------------------ */

test("a malformed settings file degrades to the defaults", () => {
  withSettings(() => {
    assert.equal(resolveHttpxBinary(), "httpx");
    assert.equal(resolveHttpxProxy(), undefined);
  }, "{ this is not json ");
});

test("a non-object settings root degrades to the defaults", () => {
  // `[]` and `"x"` are valid JSON, but neither is a settings object.
  for (const content of ["[]", '"hello"', "null", "42"]) {
    withSettings(() => {
      assert.equal(resolveHttpxProxy(), undefined, `${content} should not resolve`);
      assert.equal(resolveHttpxBinary(), "httpx", `${content} should not resolve`);
    }, content);
  }
});

test("a missing redteam block degrades to the defaults", () => {
  withSettings(() => {
    assert.equal(resolveHttpxProxy(), undefined);
    assert.equal(resolveHttpxBinary(), "httpx");
  }, JSON.stringify({ other: { tool: { binary: "/nope" } } }));
});

test("a binary configured under the wrong key is not picked up", () => {
  withSettings(() => {
    assert.equal(resolveHttpxBinary(), "httpx");
  }, JSON.stringify({ redteam: { httpx: { path: "/opt/bin/httpx" } } }));
});
