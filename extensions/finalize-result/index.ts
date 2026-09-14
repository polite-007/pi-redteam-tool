/**
 * finalize_result — persist a JSON payload to a local file.
 *
 * The tool receives a JSON payload via the `data` parameter (any
 * JSON-serialisable value) and writes it to disk at a caller-chosen path.
 * The return value echoes what was written so the LLM can confirm the
 * result.
 *
 * Behaviour:
 *   - `data` (object/array/scalar) and `path` (absolute file path) are
 *     required. `data` is the raw JSON to persist.
 *   - `format` selects JSON (default, pretty-printed) or JSONL (one object
 *     per line — useful when `data` is an array).
 *   - `indent` controls JSON pretty-printing; `0` emits compact output.
 *   - `overwrite=false` (default) refuses to clobber an existing file;
 *     pass `true` to allow replacing an existing path.
 *
 * The tool never reads from the session; this is a write-side helper.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { Type, type Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FINALIZE_TOOL_NAME = "finalize_result";

const Parameters = Type.Object({
  /**
   * The raw JSON payload to persist. Any JSON-serialisable value: object,
   * array, primitive. Required.
   */
  data: Type.Unknown(),
  /**
   * Absolute (or process-cwd-relative) filesystem path to write to.
   * Parent directories are created if missing. Required.
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

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: FINALIZE_TOOL_NAME,
    label: "Finalize Result",
    description:
      "Persist a raw JSON payload (`data`) to a local file at `path`. Use `format=jsonl` for newline-delimited streams. Returns the path, byte count, and (for jsonl) record count.",
    parameters: Parameters,
    promptGuidelines: [
      "Use this tool to materialise task results to disk so downstream automation can consume them.",
      "Pass the payload directly via `data` — no extraction needed.",
      "Set `overwrite=true` if intentionally replacing an existing artefact.",
    ],
    async execute(_toolCallId, params: Parameters, signal, _onUpdate, _ctx) {
      if (signal?.aborted) {
        throw new Error("finalize_result: aborted");
      }

      if (params.data === undefined) {
        throw new Error("finalize_result: `data` is required");
      }

      const payload = params.data;
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