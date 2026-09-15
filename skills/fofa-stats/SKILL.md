---
name: fofa-stats
description: 通过 FOFA 统计聚合接口获取资产的规模与分布（总量、按协议/端口/国家/ASN/标题等的 TOP 排名），用于快速摸清目标画像。
---

# FOFA Stats

FOFA 统计聚合接口。回答的是**"这个查询/目标有多大规模、怎么分布"**，而不是"有哪些资产"——需要资产明细列表请用 `fofa_search`。

默认聚合 `protocol,port,country` 三个字段各取 TOP 5，一次调用即可画出规模与分布的第一层画像。

## 参数

| 参数 | 类型 | 说明 |
|------|------|------|
| query | string | FOFA 查询语法，如 `domain="example.com"` |
| target | string | IP、域名或 URL，自动构建默认查询 |
| input | string | 同 target |
| fields | string | 逗号分隔的聚合字段（见下表）。省略则聚合 `protocol,port,country`；**传空字符串则只统计总量、不做聚合** |
| top | number | 每个聚合字段返回前 N 个值，默认 5，上限 100（对应 FOFA 官方参数的 `size`） |
| timeout_seconds | number | 超时秒数，默认 20，最小 5 |

`query` 与 `target`/`input` 至少给一个。FOFA 的统计接口**要求必须有查询条件**，无法"统计全网"。

## 聚合字段（官方白名单，共 12 个）

`protocol` · `domain` · `port` · `title` · `os` · `server` · `country` · `asn` · `org` · `asset_type` · `fid` · `icp`

传白名单之外的字段（例如 `banner`、`cert`）会在**本地直接拒绝并列出合法取值**，不会浪费一次接口调用。

> 注意：**没有独立的 `region` / `city` 聚合维度**。`country` 一个字段同时覆盖国家与城市，省份/城市数据以 `regions` 数组嵌套在每个国家项里面。

## 示例

```bash
# 摸清域名规模与分布（默认三字段 TOP 5）
How many assets does example.com have, and how are they distributed?

# 只统计总量，不做聚合（省额度）
Just count how many nginx servers are in China

# 指定聚合字段与 TOP 数
Aggregate the top 10 ports and countries for 1.2.3.4

# 用官方查询语法
query="app=\"nginx\"" fields="port,country" top=10
```

## 调用示例

```json
{
  "target": "example.com",
  "fields": "port,country",
  "top": 10
}
```

只统计总量：

```json
{
  "query": "app=\"nginx\" && country=\"CN\"",
  "fields": ""
}
```

## 返回

```json
{
  "query": "domain=\"example.com\"",
  "fields": ["title", "country"],
  "top": 10,
  "total": 4277422,
  "agg_keys": ["title", "countries"],
  "distinct": { "ip": 32933, "title": 82280 },
  "aggs": {
    "title": [{ "name": "百度一下, 你就知道", "count": 50220 }],
    "countries": [
      {
        "name": "China",
        "name_code": "CN",
        "count": 71,
        "code": "<base64 下钻查询>",
        "regions": [{ "name": "Beijing", "count": 41, "code": "..." }]
      }
    ]
  },
  "lastupdatetime": "2022-05-23 15:00:00",
  "consumed_fpoint": 0,
  "required_fpoints": 0
}
```

> **聚合项的结构随字段而异**。已确证的有两种：`title` 这类是 `{name, count}`；`country` 更丰富，含 `code` / `name_code` / 嵌套的 `regions`。不要假定所有字段都是 `{name, count}`——先看 `agg_keys` 和实际结构再取值。

| 字段 | 说明 |
|------|------|
| `total` | **查询命中的资产总数**（对应 FOFA 响应里的 `size`，此处已改名以免与 `top` 混淆） |
| `agg_keys` | `aggs` 里实际出现的键。**可能不等于请求的 `fields`**，见下方注意事项 |
| `distinct` | 部分字段的去重计数，如 `{ "ip": 32933 }` |
| `aggs` | 各聚合键的 TOP 列表 |
| `consumed_fpoint` / `required_fpoints` | 本次消耗 / 应付的 F 点 |

## 注意事项

- ⚠️ **`aggs` 的键名不等于 `fields` 名**。例如请求 `fields=country`，返回的键是 **`countries`**（复数）。所以要看 `agg_keys` 而不是直接按 `fields` 取值。
- ⚠️ **总量看 `total`，不要看 `top`**。FOFA 响应里那个叫 `size` 的字段是**命中总数**，和请求端表示"每个字段取前 N 个"的 `size` 是两回事；本工具已把响应端的重命名为 `total`，`top` 只表示聚合深度。
- **需要 FOFA 专业版及以上会员**。个人版/教育账号调用会失败，错误原样透传并附带提示，工具**不会**自动降级成别的查询——降级会多耗一次调用配额，还会返回语义不同的近似结果。
- **官方限速 5 秒/次**，比查询接口更严。连续调用请留出间隔。
- **`code` 字段是下钻查询**：它是把"当前查询 + 该聚合值"拼成的新查询语句再 base64，可以直接拿去发起下一次搜索。例如从 `country=CN` 下钻到具体省份。
- 不消耗 F 点的情况较多（返回示例中 `consumed_fpoint` 为 0），但官方未明确承诺免费。
