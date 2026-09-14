/**
 * finalize_result — persist a JSON payload to a local file.
 *
 * The tool receives a JSON payload directly from the caller (or parses one
 * from `source` text), then writes it to disk at a caller-chosen path. The
 * return value echoes what was written so the LLM can confirm the result.
 *
 * Behaviour:
 *   - `data` (object/array) and `path` (absolute file path) are required.
 *   - `source` is an alternative to `data`: a text string containing a JSON
 *     value that the tool will brace-match and parse before writing.
 *   - `format` selects JSON (default, pretty-printed) or JSONL (one object
 *     per line — useful when `data` is an array).
 *   - `overwrite=false` (default) refuses to clobber an existing file;
 *     pass `true` to allow replacing an existing path.
 *
 * The tool never reads from the session; this is a write-side helper, not a
 * conversation extractor.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { Type, type Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FINALIZE_TOOL_NAME = "finalize_result";

const Parameters = Type.Object({
  /**
   * The JSON payload to persist. Either this or `source` must be provided.
   * Accepts any JSON-serialisable value: object, array, primitive.
   */
  data: Type.Optional(Type.Unknown()),
  /**
   * Alternative to `data`: a text string containing JSON. The tool extracts
   * the first balanced top-level JSON value and writes that. Useful when the
   * caller wants the tool to parse LLM-emitted text directly.
   */
  source: Type.Optional(Type.String()),
  /**
   * Absolute (or process-cwd-relative) filesystem path to write to.
   * Parent directories are created if missing.
   */
  path: Type.String({ description: "Absolute file path to write the JSON payload to." }),
  /**
   * Output format. "json" pretty-prints with 2-space indent (set `indent=0`
   * for compact). "jsonl" writes one JSON object per line and requires
   * `data` to be an array.
   */
  format: Type.Optional(
    Type.Union([Type.Literal("json"), Type.Literal("jsonl")], {
      description: 'Output format. Default "json". Use "jsonl" for newline-delimited streams.',
    }),
  ),
  /** Indent for JSON output. `0` emits compact single-line. Default 2. Ignored by jsonl. */
  indent: Type.Optional(Type.Number({ description: "JSON indent (0 for compact). Default 2." })),
  /**
   * Whether to overwrite an existing file. Default false — the tool throws
   * if the target already exists.
   */
  overwrite: Type.Optional(Type.Boolean({ description: "Allow replacing an existing file. Default false." })),
});

type Parameters = Static<typeof Parameters>;

/**
 * Brace-balanced extractor for any JSON value (object, array, or scalar).
 * Tracks nesting for both `{` / `}` and `[` / `]` and skips string literals
 * with the same escape rules as the original tool. Returns the longest
 * balanced prefix starting at the first opener, or null if none balances.
 */
function extractFirstJsonValue(text: string): { value: unknown; raw: string } | null {
  // Find the first JSON opener
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{" || c === "[") {
      start = i;
      break;
    }
  }
  if (start < 0) return null;

  const openCh = text[start];
  const closeCh = openCh === "{" ? "}" : "]";
  // Track the opposing bracket too so a stray }/] inside doesn't pop us out.
  // Stack pushes only the matching pair; depth counts the primary opener.
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const close = c;
      i++;
      while (i < text.length && text[i] !== close) {
        if (text[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === "{") {
      if (openCh === "{" || depth > 0) depth++;
    } else if (c === "[") {
      if (openCh === "[" || depth > 0) depth++;
    } else if (c === "}") {
      if (openCh === "{" || depth > 0) depth--;
    } else if (c === "]") {
      if (openCh === "[" || depth > 0) depth--;
    }
    // Check balanced
    if (depth === 0 && i > start) {
      const raw = text.slice(start, i + 1);
      try {
        const value = JSON.parse(raw);
        return { value, raw };
      } catch {
        return null;
      }
    }
    i++;
  }
  return null;
}

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: FINALIZE_TOOL_NAME,
    label: "Finalize Result",
    description:
      "Persist a JSON payload to a local file. Pass the payload via `data` (any JSON value) or `source` (text containing JSON to be extracted). Writes to `path`, creating parent directories. Returns the parsed value, the path, and a byte count.",
    parameters: Parameters,
    promptGuidelines: [
      "Use this tool to materialise task results to disk so downstream automation can consume them.",
      "Prefer `data` when the payload is already structured; use `source` only when parsing LLM-emitted text.",
      "Set `overwrite=true` if intentionally replacing an existing artefact.",
    ],
    async execute(_toolCallId, params: Parameters, signal, _onUpdate, _ctx) {
      if (signal?.aborted) {
        throw new Error("finalize_result: aborted");
      }

      if (params.data === undefined && (params.source === undefined || !params.source.trim())) {
        throw new Error("finalize_result: provide either `data` or `source`");
      }

      let payload: unknown;
      let sourceText: string | undefined;

      if (params.source !== undefined && params.source.trim()) {
        const extracted = extractFirstJsonValue(params.source);
        if (!extracted) {
          throw new Error("finalize_result: no JSON value found in `source`");
        }
        payload = extracted.value;
        sourceText = extracted.raw;
      } else {
        payload = params.data;
      }

      const targetPath = isAbsolute(params.path) ? params.path : resolve(process.cwd(), params.path);
      const format = (params.format ?? "json") as "json" | "jsonl";
      const indent = params.indent ?? 2;

      let body: string;
      let writtenBytes: number;
      let recordCount: number | undefined;

      if (format === "jsonl") {
        if (!Array.isArray(payload)) {
          throw new Error("finalize_result: `format=jsonl` requires `data` to be an array");
        }
        const lines = payload.map((item) => JSON.stringify(item));
        body = lines.join("\n") + (lines.length > 0 ? "\n" : "");
        recordCount = lines.length;
        writtenBytes = Buffer.byteLength(body, "utf8");
      } else {
        const indentValue = indent <= 0 ? undefined : Math.min(8, Math.max(0, Math.floor(indent)));
        body = JSON.stringify(payload, null, indentValue as number | undefined);
        writtenBytes = Buffer.byteLength(body, "utf8");
      }

      try {
        mkdirSync(dirname(targetPath), { recursive: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`finalize_result: failed to create parent directory: ${message}`);
      }

      let replacedExisting = false;
      try {
        // Probe existing file: ENOENT means path is clear.
        // If overwrite is false and file exists, throw BEFORE writing.
        const fs = await import("node:fs");
        try {
          await fs.promises.access(targetPath);
          replacedExisting = true;
        } catch {
          replacedExisting = false;
        }
        if (replacedExisting && !params.overwrite) {
          throw new Error(
            `finalize_result: target already exists and overwrite=false: ${targetPath}`,
          );
        }
        writeFileSync(targetPath, body, { encoding: "utf8", flag: replacedExisting ? "w" : "wx" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith("finalize_result:")) throw err;
        throw new Error(`finalize_result: write failed: ${message}`);
      }

      const result: Record<string, unknown> = {
        path: targetPath,
        absolute_path: targetPath,
        format,
        bytes: writtenBytes,
        replaced_existing: replacedExisting,
      };
      if (recordCount !== undefined) result.records = recordCount;
      if (sourceText !== undefined) result.extracted_from_source = sourceText;
      result.preview = body.length > 400 ? `${body.slice(0, 400)}…` : body;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
        details: {
          path: targetPath,
          format,
          bytes: writtenBytes,
          records: recordCount,
          payload,
        },
      };
    },
  });
}