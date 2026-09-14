/**
 * Tests for the finalize_result extension tool (write-to-disk variant).
 *
 * Run with: `node --test extensions/finalize-result/index.test.mjs`
 *
 * JSDoc-typed harness; file stays `.mjs` so the runner can load it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import finalize from "./index.ts";

/**
 * @typedef {import('@earendil-works/pi-coding-agent').ExtensionAPI} ExtensionAPI
 *
 * @typedef {{
 *   name: string;
 *   description: string;
 *   parameters: unknown;
 *   execute: (
 *     toolCallId: string,
 *     params: Record<string, unknown>,
 *     signal: AbortSignal | undefined,
 *     onUpdate: unknown,
 *     ctx: ToolContext,
 *   ) => Promise<unknown>;
 * }} CapturedTool
 *
 * @typedef {{}} ToolContext
 */

function buildHarness() {
  /** @type {CapturedTool | null} */
  let captured = null;
  const pi = {
    registerTool(tool) {
      captured = tool;
    },
  };
  finalize(/** @type {ExtensionAPI} */ (pi));
  if (!captured) throw new Error("finalize_result: registerTool was never called");
  return /** @type {CapturedTool} */ (captured);
}

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "finalize-result-"));
}

test("registers the tool with expected metadata", () => {
  const tool = buildHarness();
  assert.equal(tool.name, "finalize_result");
  assert.match(tool.description, /Persist a raw JSON payload/);
  assert.equal(typeof tool.parameters, "object");
});

test("writes data to a fresh path", async () => {
  const tool = buildHarness();
  const dir = tmpDir();
  try {
    const target = join(dir, "out.json");
    const result = await tool.execute(
      "tc-1",
      { path: target, data: { answer: 42, items: ["a", "b"] } },
      undefined,
      undefined,
      {},
    );
    const payload = JSON.parse(/** @type {{ content: Array<{ text: string }> }} */ (result.content)[0].text);
    assert.equal(payload.path, target);
    assert.equal(payload.format, "json");
    assert.ok(payload.bytes > 0);
    assert.equal(payload.replaced_existing, false);

    assert.ok(existsSync(target));
    const onDisk = JSON.parse(readFileSync(target, "utf8"));
    assert.deepEqual(onDisk, { answer: 42, items: ["a", "b"] });

    assert.deepEqual(result.details.payload, { answer: 42, items: ["a", "b"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("creates parent directories", async () => {
  const tool = buildHarness();
  const dir = tmpDir();
  try {
    const target = join(dir, "deep", "nested", "out.json");
    await tool.execute(
      "tc-2",
      { path: target, data: { ok: true } },
      undefined,
      undefined,
      {},
    );
    assert.ok(existsSync(target));
    const onDisk = JSON.parse(readFileSync(target, "utf8"));
    assert.deepEqual(onDisk, { ok: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses to overwrite by default", async () => {
  const tool = buildHarness();
  const dir = tmpDir();
  try {
    const target = join(dir, "out.json");
    await tool.execute(
      "tc-seed",
      { path: target, data: { v: 1 } },
      undefined,
      undefined,
      {},
    );
    await assert.rejects(
      () => tool.execute("tc-3", { path: target, data: { v: 2 } }, undefined, undefined, {}),
      /already exists/,
    );
    // existing content untouched
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { v: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("overwrites when overwrite=true", async () => {
  const tool = buildHarness();
  const dir = tmpDir();
  try {
    const target = join(dir, "out.json");
    await tool.execute(
      "tc-seed",
      { path: target, data: { v: 1 } },
      undefined,
      undefined,
      {},
    );
    const result = await tool.execute(
      "tc-4",
      { path: target, data: { v: 2 }, overwrite: true },
      undefined,
      undefined,
      {},
    );
    const payload = JSON.parse(/** @type {{ content: Array<{ text: string }> }} */ (result.content)[0].text);
    assert.equal(payload.replaced_existing, true);
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { v: 2 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writes JSONL with one record per line", async () => {
  const tool = buildHarness();
  const dir = tmpDir();
  try {
    const target = join(dir, "stream.jsonl");
    const items = [{ a: 1 }, { a: 2 }, { a: 3 }];
    const result = await tool.execute(
      "tc-5",
      { path: target, data: items, format: "jsonl" },
      undefined,
      undefined,
      {},
    );
    const onDisk = readFileSync(target, "utf8");
    const lines = onDisk.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 3);
    assert.deepEqual(lines.map((l) => JSON.parse(l)), items);
    const payload = JSON.parse(/** @type {{ content: Array<{ text: string }> }} */ (result.content)[0].text);
    assert.equal(payload.format, "jsonl");
    assert.equal(payload.records, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects JSONL on non-array data", async () => {
  const tool = buildHarness();
  await assert.rejects(
    () =>
      tool.execute(
        "tc-6",
        { path: "/tmp/x.jsonl", data: { not: "array" }, format: "jsonl" },
        undefined,
        undefined,
        {},
      ),
    /requires .* array/,
  );
});

test("honours indent=0 for compact output", async () => {
  const tool = buildHarness();
  const dir = tmpDir();
  try {
    const target = join(dir, "compact.json");
    await tool.execute(
      "tc-7",
      { path: target, data: { a: 1, b: 2 }, indent: 0 },
      undefined,
      undefined,
      {},
    );
    const onDisk = readFileSync(target, "utf8");
    assert.equal(onDisk, '{"a":1,"b":2}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preserves deeply nested objects", async () => {
  const tool = buildHarness();
  const dir = tmpDir();
  try {
    const target = join(dir, "nested.json");
    const payload = { a: { b: { c: [1, 2, { d: "x" }] } }, e: null, f: true };
    await tool.execute("tc-8", { path: target, data: payload }, undefined, undefined, {});
    const onDisk = JSON.parse(readFileSync(target, "utf8"));
    assert.deepEqual(onDisk, payload);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writes top-level arrays", async () => {
  const tool = buildHarness();
  const dir = tmpDir();
  try {
    const target = join(dir, "arr.json");
    await tool.execute(
      "tc-9",
      { path: target, data: [{ a: 1 }, { b: 2 }] },
      undefined,
      undefined,
      {},
    );
    const onDisk = JSON.parse(readFileSync(target, "utf8"));
    assert.deepEqual(onDisk, [{ a: 1 }, { b: 2 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("throws when data is omitted", async () => {
  const tool = buildHarness();
  await assert.rejects(
    () => tool.execute("tc-10", { path: "/tmp/x.json" }, undefined, undefined, {}),
    /`data` is required/,
  );
});

test("throws when path is omitted", async () => {
  const tool = buildHarness();
  await assert.rejects(
    () => tool.execute("tc-11", { data: { ok: true } }, undefined, undefined, {}),
    /path/,
  );
});

test("honours pre-aborted signal", async () => {
  const tool = buildHarness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      tool.execute(
        "tc-12",
        { path: "/tmp/x.json", data: { ok: true } },
        controller.signal,
        undefined,
        {},
      ),
    /aborted/,
  );
});

test("returns byte count matching on-disk size", async () => {
  const tool = buildHarness();
  const dir = tmpDir();
  try {
    const target = join(dir, "out.json");
    const result = await tool.execute(
      "tc-13",
      { path: target, data: { hello: "world" } },
      undefined,
      undefined,
      {},
    );
    const payload = JSON.parse(/** @type {{ content: Array<{ text: string }> }} */ (result.content)[0].text);
    const stat = statSync(target);
    assert.equal(payload.bytes, stat.size);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});