# finalize_result

Persist a raw JSON payload to a local file. This is a **write-side**
helper — it never reads from the conversation or session history. Use it
as the closing step of a task to materialise a structured result that
downstream automation can consume.

## Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `data` | any JSON | yes | The raw payload to persist. Any JSON-serialisable value: object, array, primitive. |
| `path` | string | no | Output file path. Defaults to `<cwd>/finalize-result/<session-id>.json` (the session id is sanitised for safe filenames; falls back to a UTC timestamp if no session id is available). |
| `format` | `"json"` \| `"jsonl"` | no, default `"json"` | `jsonl` writes one JSON object per line and requires `data` to be an array. |
| `indent` | number | no, default `2` | Indent for JSON output. `0` emits compact single-line. Ignored by `jsonl`. |
| `overwrite` | boolean | no, default `false` | When `false`, the tool refuses to replace an existing file. |

## Default output location

When `path` is omitted, the tool writes to:

```
<process cwd>/finalize-result/<session-id>.json
```

The default directory is created automatically. The session id is taken from the active Pi session (`ctx.sessionManager.getSessionId()`) and sanitised to strip characters that aren't safe in filenames (`<`, `>`, `:`, `"`, `|`, `?`, `*`, control characters, path separators). If no session id is available, a UTC timestamp (`YYYY-MM-DDTHH-MM-SS-mmmZ`) is used as the filename instead.

## Behaviour

1. Resolves the output path: explicit `path` wins, otherwise the default per-session location.
2. Takes `data` directly — no extraction or parsing.
3. Serialises:
   - `format=json` → `JSON.stringify(data, null, indent)`
   - `format=jsonl` → one `JSON.stringify(item)` per array element, newline-terminated.
4. Creates parent directories if missing.
5. Refuses to overwrite by default; pass `overwrite=true` to allow it.
6. Returns the resolved path, byte count, and (for jsonl) the record count.

## Return shape

```json
{
  "path": "/abs/path/to/file.json",
  "absolute_path": "/abs/path/to/file.json",
  "format": "json",
  "bytes": 1234,
  "replaced_existing": false,
  "records": 42,            // only for jsonl
  "preview": "first 400 chars…"
}
```

## Examples

Write to a specific file:
```json
{
  "path": "/tmp/osint/example.com.json",
  "data": {
    "domain": "example.com",
    "asn": "AS15169",
    "country": "US",
    "open_ports": [80, 443]
  }
}
```

Write to the default per-session location (omit `path`):
```json
{
  "data": {
    "domain": "example.com",
    "open_ports": [80, 443]
  }
}
```
→ lands at `<cwd>/finalize-result/<session-id>.json`

Write a newline-delimited stream:
```json
{
  "path": "/tmp/osint/example.com.jsonl",
  "format": "jsonl",
  "data": [
    { "ip": "1.2.3.4", "port": 80 },
    { "ip": "1.2.3.4", "port": 443 }
  ]
}
```

Compact single-line JSON (no whitespace):
```json
{
  "path": "/tmp/result.json",
  "data": { "status": "ok", "count": 3 },
  "indent": 0
}
```