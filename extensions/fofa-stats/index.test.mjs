/**
 * Tests for the fofa_stats extension.
 *
 * Run with: `node --test extensions/fofa-stats/index.test.mjs`
 *
 * The network is never touched: `globalThis.fetch` is stubbed with node:test's
 * built-in mock, so the real `execute` path (success, API-level error, HTTP
 * failure, cancellation) is exercised without spending F-points or needing a
 * FOFA account.
 *
 * JSDoc-typed harness; file stays `.mjs` so the runner can load it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_TOP,
  MAX_TOP,
  STATS_AGG_FIELDS,
  clampTimeoutSeconds,
  clampTop,
  normalizeStats,
  resolveStatsFields,
  resolveStatsQuery,
} from "./index.ts";
import register from "./index.ts";

/* ------------------------------------------------------------------ *
 * harness
 * ------------------------------------------------------------------ */

const FOFA_ENV_KEYS = [
  "REDTEAM_FOFA_KEY",
  "REDTEAM_FOFA_EMAIL",
  "REDTEAM_FOFA_BASE_URL",
  "PI_SETTINGS_PATH",
];

/**
 * A path that cannot exist. Every test pins PI_SETTINGS_PATH to this, so no
 * test can silently read the developer's real ~/.pi/agent/settings.json and
 * pass or fail depending on the machine it runs on.
 */
const NO_SETTINGS_FILE = join(tmpdir(), "fofa-stats-must-not-be-read.json");

/**
 * Run `body` with a stubbed FOFA environment, then always restore — including
 * deleting vars that were absent to begin with, since assigning `undefined`
 * would leave the literal string "undefined" behind. Async-aware: the
 * environment stays installed until `body` settles.
 *
 * Pass `key: null` for "no credentials". (Not `undefined` — a destructuring
 * default fires on `undefined`, which would silently install the test key.)
 */
async function withEnv(body, { key = "test-key" } = {}) {
  const saved = {};
  for (const name of FOFA_ENV_KEYS) saved[name] = process.env[name];
  if (key) process.env.REDTEAM_FOFA_KEY = key;
  else delete process.env.REDTEAM_FOFA_KEY;
  delete process.env.REDTEAM_FOFA_EMAIL;
  delete process.env.REDTEAM_FOFA_BASE_URL;
  process.env.PI_SETTINGS_PATH = NO_SETTINGS_FILE;
  try {
    return await body();
  } finally {
    for (const name of FOFA_ENV_KEYS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

/** Convenience wrapper: a configured account. */
function withKey(body) {
  return withEnv(body);
}

/** Convenience wrapper: no credentials anywhere. */
function withoutKey(body) {
  return withEnv(body, { key: null });
}

/** Capture the tool this extension registers. */
function buildHarness() {
  /** @type {any} */
  let captured = null;
  register({
    registerTool(tool) {
      captured = tool;
    },
  });
  if (!captured) throw new Error("fofa_stats: registerTool was never called");
  return captured;
}

/** A minimal stand-in for a fetch Response. */
function fakeResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

/** Parse the JSON the tool handed back as its text content. */
function readPayload(result) {
  return JSON.parse(result.content[0].text);
}

/** A representative successful FOFA stats response. */
const SAMPLE = {
  error: false,
  consumed_fpoint: 0,
  required_fpoints: 0,
  size: 4277422,
  distinct: { ip: 32933, title: 82280 },
  aggs: {
    protocol: [{ count: 100, name: "http" }],
    // Note the pluralised key — `fields=country` comes back as `countries`.
    countries: [
      {
        code: "aG9zdD0iZm9mYS5pbmZvIiAmJiBjb3VudHJ5PSJDTiI=",
        name: "China",
        name_code: "CN",
        count: 71,
        regions: [{ code: "x", name: "Beijing", count: 41 }],
      },
    ],
  },
  lastupdatetime: "2022-05-23 15:00:00",
};

/* ------------------------------------------------------------------ *
 * resolveStatsFields
 * ------------------------------------------------------------------ */

test("resolveStatsFields: defaults to protocol,port,country", () => {
  assert.deepEqual(resolveStatsFields(undefined), ["protocol", "port", "country"]);
});

test("resolveStatsFields: a blank string means total-only, no aggregation", () => {
  assert.deepEqual(resolveStatsFields(""), []);
  assert.deepEqual(resolveStatsFields("   "), []);
});

test("resolveStatsFields: parses, trims and de-duplicates a list", () => {
  assert.deepEqual(resolveStatsFields(" port , country ,port"), ["port", "country"]);
});

test("resolveStatsFields: rejects fields outside the official whitelist", () => {
  assert.throws(
    () => resolveStatsFields("port,banner"),
    /无法聚合的字段: banner[\s\S]*仅支持: protocol/,
  );
});

test("resolveStatsFields: the whitelist is exactly the 12 documented fields", () => {
  assert.deepEqual([...STATS_AGG_FIELDS], [
    "protocol",
    "domain",
    "port",
    "title",
    "os",
    "server",
    "country",
    "asn",
    "org",
    "asset_type",
    "fid",
    "icp",
  ]);
});

/* ------------------------------------------------------------------ *
 * clampTop / clampTimeoutSeconds
 * ------------------------------------------------------------------ */

test("clampTop: defaults to 5 and clamps into [1, 100]", () => {
  assert.equal(clampTop(undefined), DEFAULT_TOP);
  assert.equal(clampTop(0), 1);
  assert.equal(clampTop(-10), 1);
  assert.equal(clampTop(1000), MAX_TOP);
  assert.equal(clampTop(20), 20);
});

test("clampTop: non-finite input falls back to the default", () => {
  assert.equal(clampTop(Number.NaN), DEFAULT_TOP);
  assert.equal(clampTop(Number.POSITIVE_INFINITY), DEFAULT_TOP);
});

test("clampTimeoutSeconds: defaults to 20 and floors at 5", () => {
  assert.equal(clampTimeoutSeconds(undefined), 20);
  assert.equal(clampTimeoutSeconds(1), 5);
  assert.equal(clampTimeoutSeconds(60), 60);
});

/* ------------------------------------------------------------------ *
 * resolveStatsQuery
 * ------------------------------------------------------------------ */

test("resolveStatsQuery: an explicit query wins over target", () => {
  assert.equal(
    resolveStatsQuery({ query: 'title="nginx"', target: "example.com" }),
    'title="nginx"',
  );
});

test("resolveStatsQuery: a target builds the default query", () => {
  assert.equal(resolveStatsQuery({ target: "example.com" }), 'domain="example.com"');
  assert.equal(resolveStatsQuery({ input: "1.2.3.4" }), 'ip="1.2.3.4"');
});

test("resolveStatsQuery: rejects having neither query nor target", () => {
  assert.throws(() => resolveStatsQuery({}), /缺少 query 或 target\/input/);
});

test("resolveStatsQuery: rejects an unparseable target", () => {
  assert.throws(() => resolveStatsQuery({ target: "not a target here" }), /无法解析资产/);
});

/* ------------------------------------------------------------------ *
 * normalizeStats
 * ------------------------------------------------------------------ */

test("normalizeStats: renames the response's size to total", () => {
  const payload = normalizeStats(SAMPLE, {
    query: 'title="百度"',
    fields: ["protocol", "country"],
    top: 5,
  });
  assert.equal(payload.total, 4277422);
  // The whole point of the rename: `size` must not leak through as a synonym
  // for the request-side TOP-N.
  assert.equal("size" in payload, false);
  assert.equal(payload.top, 5);
});

test("normalizeStats: exposes agg_keys so pluralised keys are visible", () => {
  const payload = normalizeStats(SAMPLE, { query: "q", fields: ["country"], top: 5 });
  assert.deepEqual(payload.agg_keys, ["protocol", "countries"]);
  assert.ok(Array.isArray(payload.aggs.countries));
  assert.equal(payload.aggs.countries[0].regions[0].name, "Beijing");
});

test("normalizeStats: carries distinct and the f-point / freshness metadata", () => {
  const payload = normalizeStats(SAMPLE, { query: "q", fields: [], top: 5 });
  assert.deepEqual(payload.distinct, { ip: 32933, title: 82280 });
  assert.equal(payload.lastupdatetime, "2022-05-23 15:00:00");
  assert.equal(payload.consumed_fpoint, 0);
  assert.equal(payload.required_fpoints, 0);
});

test("normalizeStats: tolerates a response with no aggs or metadata", () => {
  const payload = normalizeStats({ error: false, size: 7 }, { query: "q", fields: [], top: 5 });
  assert.equal(payload.total, 7);
  assert.deepEqual(payload.aggs, {});
  assert.deepEqual(payload.agg_keys, []);
  assert.deepEqual(payload.distinct, {});
  assert.equal("lastupdatetime" in payload, false);
});

/* ------------------------------------------------------------------ *
 * execute — unconfigured
 * ------------------------------------------------------------------ */

test("execute: reports a missing key without calling the network", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch should not have been called");
  });
  await withoutKey(async () => {
    const result = await buildHarness().execute("tc", { query: "q" }, undefined, undefined, {});
    assert.equal(result.isError, true);
    assert.equal(readPayload(result).error, "FOFA_NOT_CONFIGURED");
    assert.equal(fetchMock.mock.callCount(), 0);
  });
});

/* ------------------------------------------------------------------ *
 * execute — request shape
 * ------------------------------------------------------------------ */

test("execute: sends key, qbase64, fields and size to the stats endpoint", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => fakeResponse(SAMPLE));

  await withKey(async () => {
    const result = await buildHarness().execute(
      "tc",
      { query: 'title="百度"', fields: "protocol,country", top: 3 },
      undefined,
      undefined,
      {},
    );

    const [calledUrl] = fetchMock.mock.calls[0].arguments;
    const url = new URL(calledUrl.toString());
    assert.equal(url.origin + url.pathname, "https://fofa.info/api/v1/search/stats");
    assert.equal(url.searchParams.get("key"), "test-key");
    assert.equal(url.searchParams.get("fields"), "protocol,country");
    assert.equal(url.searchParams.get("size"), "3");
    assert.equal(
      url.searchParams.get("qbase64"),
      Buffer.from('title="百度"', "utf8").toString("base64"),
    );
    assert.equal(result.isError, undefined);
  });
});

test("execute: a query is mandatory — qbase64 is never sent empty", async (t) => {
  t.mock.method(globalThis, "fetch", async () => fakeResponse(SAMPLE));

  await withKey(async () => {
    const result = await buildHarness().execute("tc", {}, undefined, undefined, {});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /缺少 query 或 target\/input/);
  });
});

test("execute: fields='' omits the fields parameter for a total-only query", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => fakeResponse(SAMPLE));

  await withKey(async () => {
    const result = await buildHarness().execute(
      "tc",
      { query: "q", fields: "" },
      undefined,
      undefined,
      {},
    );
    const url = new URL(fetchMock.mock.calls[0].arguments[0].toString());
    assert.equal(url.searchParams.has("fields"), false);
    assert.deepEqual(readPayload(result).fields, []);
  });
});

test("execute: invalid aggregation fields are rejected before any network call", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => fakeResponse(SAMPLE));

  await withKey(async () => {
    const result = await buildHarness().execute(
      "tc",
      { query: "q", fields: "port,banner" },
      undefined,
      undefined,
      {},
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /无法聚合的字段: banner/);
    assert.equal(fetchMock.mock.callCount(), 0);
  });
});

/* ------------------------------------------------------------------ *
 * execute — success
 * ------------------------------------------------------------------ */

test("execute: returns a normalised payload on success", async (t) => {
  t.mock.method(globalThis, "fetch", async () => fakeResponse(SAMPLE));

  await withKey(async () => {
    const result = await buildHarness().execute(
      "tc",
      { query: "q", fields: "protocol,country" },
      undefined,
      undefined,
      {},
    );
    assert.equal(result.isError, undefined);
    const payload = readPayload(result);
    assert.equal(payload.total, 4277422);
    assert.equal("size" in payload, false);
    assert.deepEqual(payload.fields, ["protocol", "country"]);
    assert.equal(payload.top, DEFAULT_TOP);
    assert.ok(payload.agg_keys.includes("countries"));
  });
});

/* ------------------------------------------------------------------ *
 * execute — failures
 * ------------------------------------------------------------------ */

test("execute: surfaces an API-level error with a membership hint", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    fakeResponse({ error: true, errmsg: "[-700] 账号无效" }),
  );

  await withKey(async () => {
    const result = await buildHarness().execute("tc", { query: "q" }, undefined, undefined, {});
    assert.equal(result.isError, true);
    const payload = readPayload(result);
    assert.equal(payload.error, true);
    assert.equal(payload.errmsg, "[-700] 账号无效");
    assert.match(payload.hint, /专业版/);
  });
});

test("execute: reports a non-2xx response with its status", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    fakeResponse({ nope: true }, { ok: false, status: 429 }),
  );

  await withKey(async () => {
    const result = await buildHarness().execute("tc", { query: "q" }, undefined, undefined, {});
    assert.equal(result.isError, true);
    const payload = readPayload(result);
    assert.equal(payload.status, 429);
    assert.match(payload.message, /HTTP 429/);
  });
});

test("execute: handles a non-JSON body without throwing", async (t) => {
  t.mock.method(globalThis, "fetch", async () => fakeResponse("<html>gateway</html>"));

  await withKey(async () => {
    const result = await buildHarness().execute("tc", { query: "q" }, undefined, undefined, {});
    assert.equal(result.isError, true);
    assert.match(readPayload(result).errmsg, /gateway/);
  });
});

test("execute: cancelling the caller's signal aborts the request", async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async (_url, opts) => {
    return new Promise((_resolve, reject) => {
      opts.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  });

  await withKey(async () => {
    const pending = buildHarness().execute(
      "tc",
      { query: "q" },
      controller.signal,
      undefined,
      {},
    );
    controller.abort();
    const result = await pending;
    assert.equal(result.isError, true);
    const { message } = readPayload(result);
    assert.match(message, /已取消/);
    // A deliberate cancel must not be reported as a timeout.
    assert.doesNotMatch(message, /超时/);
  });
});

test("execute: an already-aborted signal never reaches the network", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch should not have been called");
  });
  const controller = new AbortController();
  controller.abort();

  await withKey(async () => {
    const result = await buildHarness().execute(
      "tc",
      { query: "q" },
      controller.signal,
      undefined,
      {},
    );
    assert.equal(result.isError, true);
    assert.match(readPayload(result).message, /已取消/);
    assert.equal(fetchMock.mock.callCount(), 0);
  });
});
