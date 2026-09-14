/**
 * finalize_result — extract a JSON object from the final assistant message.
 *
 * The tool reaches back to the active session's message history and pulls out
 * the last assistant turn. It then performs brace-matched JSON extraction
 * (with string-boundary skipping) and returns the parsed object.
 *
 * Behaviour:
 *   - Without `source`, the tool looks at `ctx.sessionManager.getEntries()`
 *     and uses the trailing assistant message.
 *   - With `source`, the tool runs the same extractor over the supplied text.
 *   - If no JSON object can be located, the tool throws an error so the LLM
 *     can retry or surface the failure to the caller.
 */
import { Type, type Static } from "typebox";
import type { ExtensionAPI, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

const FINALIZE_TOOL_NAME = "finalize_result";

const Parameters = Type.Object({
  /**
   * Optional explicit text source. When omitted, the tool reaches into the
   * active session for the last assistant message.
   */
  source: Type.Optional(Type.String()),
  /**
   * Optional human-readable label forwarded to result metadata. Useful when
   * the caller wants the resulting object tagged.
   */
  label: Type.Optional(Type.String()),
});

type Parameters = Static<typeof Parameters>;

/**
 * Brace-matched JSON extraction with string-boundary skipping. Returns the
 * first balanced top-level object found, or `null` when none can be parsed.
 */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 1;
  let i = start + 1;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === '"' || ch === "'") {
      const close = ch;
      i++;
      while (i < text.length && text[i] !== close) {
        if (text[i] === "\\") i++;
        i++;
      }
    }
    i++;
  }
  if (depth !== 0) return null;
  try {
    const parsed = JSON.parse(text.slice(start, i));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Concatenate every text block of an assistant message so we can search
 * across thinking + visible content.
 */
function assistantText(message: SessionMessageEntry): string {
  if (message.message.role !== "assistant") return "";
  const blocks = (message.message as { content?: unknown }).content;
  if (!Array.isArray(blocks)) return "";
  let out = "";
  for (const block of blocks) {
    if (
      block &&
      typeof block === "object" &&
      "type" in block &&
      (block as { type?: unknown }).type === "text" &&
      "text" in block &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      out += (block as { text: string }).text;
    }
  }
  return out;
}

/**
 * Locate the trailing assistant message in the session entry log.
 */
function lastAssistantText(entries: ReadonlyArray<unknown>): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as Partial<SessionMessageEntry> | undefined;
    if (entry && entry.type === "message" && entry.message?.role === "assistant") {
      const text = assistantText(entry as SessionMessageEntry);
      if (text) return text;
    }
  }
  return "";
}

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: FINALIZE_TOOL_NAME,
    label: "Finalize Result",
    description:
      "Extract a structured JSON object from the conversation. Without `source`, the tool reads the last assistant message from the active session. The returned object is sent back as the tool result; the raw text is also surfaced under `text`.",
    parameters: Parameters,
    promptGuidelines: [
      "Call this tool as the last step of any task that needs a structured payload.",
      "If the extracted object is empty or missing required keys, return a structured error instead of guessing.",
    ],
    async execute(_toolCallId, params: Parameters, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        throw new Error("finalize_result: aborted");
      }

      const explicit = params.source?.trim();
      let sourceText: string;
      if (explicit && explicit.length > 0) {
        sourceText = explicit;
      } else {
        const sessionManager = ctx.sessionManager;
        if (!sessionManager) {
          throw new Error("finalize_result: no session manager available");
        }
        sourceText = lastAssistantText(
          sessionManager.getEntries() as unknown as unknown[],
        );
        if (!sourceText) {
          throw new Error("finalize_result: no assistant message found in session");
        }
      }

      const parsed = extractJsonObject(sourceText);
      if (!parsed) {
        throw new Error("finalize_result: no JSON object found in source text");
      }

      const label = params.label?.trim();
      const result: Record<string, unknown> = {
        text: sourceText,
        result: parsed,
      };
      if (label) result.label = label;

      // Notify the UI when present so the front-end can refresh.
      try {
        ctx.ui?.notify?.(
          JSON.stringify({
            title: label ? `finalize_result: ${label}` : "finalize_result",
            body: "Structured result captured.",
            content: JSON.stringify(parsed),
          }),
        );
      } catch {
        // notifications are best-effort
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
        details: parsed,
      };
    },
  });
}