/**
 * Tests for the finalize_result extension tool.
 *
 * Run with: `node --test extensions/finalize-result/index.test.mjs`
 *
 * Type hints are inlined as JSDoc — this file stays `.mjs` so the test
 * runner can load it directly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import finalize from "./index.ts";

/**
 * @typedef {import('@earendil-works/pi-coding-agent').ExtensionAPI} ExtensionAPI
 * @typedef {import('@earendil-works/pi-coding-agent').SessionMessageEntry} SessionMessageEntry
 */

/**
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
 * @typedef {{
 *   sessionManager?: { getEntries(): unknown[] };
 *   ui?: { notify?: (payload: unknown) => void };
 * }} ToolContext
 */

function buildHarness(opts = {}) {
  /** @type {{ notify?: unknown }} */
  const calls = {};
  /** @type {ToolContext} */
  const ctx = {};
  if (opts.entries !== undefined) {
    ctx.sessionManager = { getEntries: () => opts.entries ?? [] };
  }
  if (opts.notify) {
    ctx.ui = {
      notify: (payload) => {
        calls.notify = payload;
      },
    };
  }

  /** @type {CapturedTool | null} */
  let captured = null;
  const pi = {
    registerTool(tool) {
      captured = tool;
    },
  };

  finalize(/** @type {ExtensionAPI} */ (pi));
  if (!captured) throw new Error("finalize_result: registerTool was never called");
  return { tool: /** @type {CapturedTool} */ (captured), calls, ctx };
}

function assistantEntry(text) {
  return {
    type: "message",
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: new Date().toISOString(),
    },
  };
}

test("registers the tool with expected metadata", () => {
  const { tool } = buildHarness();
  assert.equal(tool.name, "finalize_result");
  assert.match(tool.description, /Extract a structured JSON object/);
  assert.equal(typeof tool.parameters, "object");
});

test("extracts JSON from explicit source", async () => {
  const { tool, ctx } = buildHarness();
  const text = 'Here is the answer:\n{"answer":42,"items":["a","b"]}\nDone.';
  const result = await tool.execute(
    "tc-1",
    { source: text },
    undefined,
    undefined,
    ctx,
  );
  const payload = JSON.parse(result.content[0].text);
  assert.deepEqual(payload.result, { answer: 42, items: ["a", "b"] });
  assert.equal(payload.text, text);
  assert.deepEqual(result.details, { answer: 42, items: ["a", "b"] });
});

test("extracts JSON from trailing assistant message when source omitted", async () => {
  const text = 'After thinking: {"status":"ok","count":3}';
  const entries = [
    {
      type: "message",
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "do thing" },
    },
    assistantEntry("earlier text without json"),
    assistantEntry(text),
  ];
  const { tool, ctx } = buildHarness({ entries });
  const result = await tool.execute("tc-2", {}, undefined, undefined, ctx);
  assert.deepEqual(result.details, { status: "ok", count: 3 });
});

test("throws when no JSON object can be parsed", async () => {
  const { tool, ctx } = buildHarness();
  await assert.rejects(
    () =>
      tool.execute("tc-3", { source: "no braces here" }, undefined, undefined, ctx),
    /no JSON object found/,
  );
});

test("throws when source omitted and no assistant message exists", async () => {
  const { tool, ctx } = buildHarness({ entries: [] });
  await assert.rejects(
    () => tool.execute("tc-4", {}, undefined, undefined, ctx),
    /no assistant message found/,
  );
});

test("throws when source omitted and session manager missing", async () => {
  const { tool, ctx } = buildHarness();
  await assert.rejects(
    () => tool.execute("tc-5", {}, undefined, undefined, ctx),
    /no session manager available/,
  );
});

test("honours pre-aborted signal", async () => {
  const { tool, ctx } = buildHarness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      tool.execute("tc-6", { source: "{}" }, controller.signal, undefined, ctx),
    /aborted/,
  );
});

test("forwards label to UI when present", async () => {
  const { tool, ctx, calls } = buildHarness({ notify: true });
  await tool.execute(
    "tc-7",
    { source: '{"x":1}', label: "demo" },
    undefined,
    undefined,
    ctx,
  );
  assert.ok(calls.notify, "notify must have been called");
  const payload = JSON.parse(calls.notify);
  assert.equal(payload.title, "finalize_result: demo");
  assert.equal(JSON.parse(payload.content).x, 1);
});

test("ignores malformed JSON inside strings", async () => {
  const { tool, ctx } = buildHarness();
  const text =
    'Note: use {"k":"v} which has braces in a string"} outer {"answer":"yes"}';
  const result = await tool.execute(
    "tc-8",
    { source: text },
    undefined,
    undefined,
    ctx,
  );
  assert.deepEqual(result.details, { k: "v} which has braces in a string" });
});

test("string-boundary skipping survives escaped quote inside literal", async () => {
  const { tool, ctx } = buildHarness();
  const text = 'pre {"label":"a \\"quoted\\" word","ok":true} post';
  const result = await tool.execute(
    "tc-9",
    { source: text },
    undefined,
    undefined,
    ctx,
  );
  assert.deepEqual(result.details, { label: 'a "quoted" word', ok: true });
});