---
name: finalize-result
description: 把任意 JSON 数据通过 `data` 参数直接写入本地文件，作为任务流水线的收尾步骤，让下游自动化系统消费结构化结果。
---

# Finalize Result

把任务产出的 JSON 落地到本地文件。工具**只接收原始 JSON 数据**（`data`），不做任何文本提取或解析 —— 数据就是原样写入。

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| data | any JSON | ✅ | 要落盘的原始数据（对象 / 数组 / 标量都可） |
| path | string | ✅ | 绝对路径或相对 cwd 的路径，父目录自动创建 |
| format | `json` \| `jsonl` |  | 默认 `json`；`jsonl` 要求 data 是数组，一行一条记录 |
| indent | number |  | 默认 2，`0` 表示紧凑无缩进；jsonl 忽略 |
| overwrite | boolean |  | 默认 `false`，已存在则拒绝写入；设为 `true` 允许覆盖 |

## 示例

```bash
# 把侦察报告落盘
Save the asset list to /tmp/osint/example.com.json

# 写出 JSONL 流
Save these findings as JSONL to /tmp/findings.jsonl

# 紧凑输出
Save compact result to /tmp/result.json with indent=0
```

## 调用示例

写入一个结构化报告：

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

写入 JSONL 流：

```json
{
  "path": "/tmp/osint/findings.jsonl",
  "format": "jsonl",
  "data": [
    { "ip": "1.2.3.4", "port": 80 },
    { "ip": "1.2.3.4", "port": 443 }
  ]
}
```

## 返回

```json
{
  "path": "/abs/path/to/file.json",
  "absolute_path": "/abs/path/to/file.json",
  "format": "json",
  "bytes": 1234,
  "replaced_existing": false,
  "records": 42,
  "preview": "前 400 字符…"
}
```

## 注意

- 工具**不读取**对话 / session 历史 —— 纯粹是写盘助手
- `data` 直接 `JSON.stringify`，不会改字段名或结构
- 默认拒绝覆盖现有文件，避免误操作覆盖