# finalize_result

Persist a JSON payload to a local file. This is a **write-side** helper —
it never reads from the conversation or session history. Use it as the
closing step of a task to materialise a structured result that downstream
automation can consume.

## Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `data` | any JSON | one of these | The payload to write. Any JSON-serialisable value: object, array, primitive. |
| `source` | string | one of these | Alternative to `data`: text containing JSON. The tool extracts the first balanced value. |
| `path` | string | yes | Absolute path, or a path relative to the current working directory. Parent directories are created. |
| `format` | `"json"` \| `"jsonl"` | no, default `"json"` | `jsonl` writes one JSON object per line and requires `data` to be an array. |
| `indent` | number | no, default `2` | Indent for JSON output. `0` emits compact single-line. Ignored by `jsonl`. |
| `overwrite` | boolean | no, default `false` | When `false`, the tool refuses to replace an existing file. |

## Behaviour

1. Resolves the payload: uses `data` directly, or extracts the first balanced
   JSON value from `source` (objects and arrays both supported).
2. Serialises:
   - `format=json` → `JSON.stringify(payload, null, indent)`
   - `format=jsonl` → one `JSON.stringify(item)` per array element, newline-terminated.
3. Creates parent directories if missing.
4. Refuses to overwrite by default; pass `overwrite=true` to allow it.
5. Returns the resolved path, byte count, and (for jsonl) the record count.

## Return shape

```json
{
  "path": "/abs/path/to/file.json",
  "absolute_path": "/abs/path/to/file.json",
  "format": "json",
  "bytes": 1234,
  "replaced_existing": false,
  "records": 42,            // only for jsonl
  "extracted_from_source": "…", // only when source was used
  "preview": "first 400 chars…"
}
```

## Examples

Write a structured report:
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

Write a newline-delimited stream from an array:
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

Extract JSON from LLM-emitted text:
```json
{
  "path": "/tmp/result.json",
  "source": "Here is the summary: {\"status\":\"ok\",\"count\":3}\n"
}
```