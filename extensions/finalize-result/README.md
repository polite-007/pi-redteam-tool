# finalize_result

Extract a structured JSON object from the conversation. Used as the closing
step of a task pipeline so downstream consumers always receive a parseable
result.

## When to call

Call this tool **last** in any task whose result needs to be consumed by
another system. The tool:

1. Reads the last assistant message from the active session (or uses the
   `source` parameter if provided).
2. Brace-matches the first `{ ... }` block, skipping over string literals.
3. Returns the parsed object as the tool result, with the raw text preserved
   under `text`.

If no JSON object is found the tool throws, allowing the LLM to either retry
or surface the failure.

## Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `source` | string | optional | Explicit text to scan. When omitted, the last assistant message in the active session is used. |
| `label` | string | optional | A short label forwarded to the result metadata and the UI notification. |

## Result shape

The tool returns:

```json
{
  "text": "...raw assistant text...",
  "result": { "...": "parsed JSON object" },
  "label": "optional label"
}
```

The `details` field on the tool call carries the same `result` object so the
runtime can attach it to the assistant message.

## UI notification

If a UI surface is present, the tool posts a notification with title
`finalize_result` (or `finalize_result: <label>`) so the front-end can
refresh any pending task panel.