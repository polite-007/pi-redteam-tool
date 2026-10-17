---
name: net-lookup
description: 网络归属查询：BGP/ASN 路由信息 + RDAP/WHOIS 注册信息，支持联合研判。
---

# Network Lookup

一个工具，三个查询模式，用于回答“这个 IP / 域名是谁的”：

- **bgp** — 路由视角：ASN、前缀、接入网 vs 基础设施分类（BGPView）
- **whois** — 注册视角：IP / 域名注册信息（RDAP + JPNIC WHOIS）
- **all** — 并行执行以上两者，输出合并后的归属研判

`mode=auto`（默认）在 IP 上使用 `all`，在域名上使用 `whois`。

## 参数

| 参数 | 类型 | 模式 | 说明 |
|------|------|------|------|
| target | string | 全部 | IP、域名或 URL |
| input | string | 全部 | 同 target |
| ip | string | bgp | IPv4 别名 |
| mode | string | 全部 | `auto`（默认）/ `bgp` / `whois` / `all` |
| gateway | string | whois | `auto` / `jpnic` / `apnic` / `arin` / `ripe` / `rdap` |
| raw | boolean | bgp / whois | 返回原始数据；`all` 和 IP 的 `auto` 不支持 |
| timeout_seconds | number | 全部 | 超时秒数，默认 20 |

## 示例

```bash
# 自动模式：IP 联合 BGP + RDAP
Who owns 8.8.8.8?

# 只看路由信息
Lookup BGP/ASN data for 1.2.3.4

# 只查注册信息
Find registration details for example.com

# 强制日本网关
Query WHOIS for 103.2.0.0 with gateway=jpnic

# 获取原始数据
Return raw RDAP JSON for 8.8.8.8
```

## bgp 模式

数据源：BGPView（无需 API Key），仅支持 IPv4。

返回字段：

| 字段 | 说明 |
|------|------|
| asn | ASN 编号（如 AS15169） |
| asnName / asnDescription | ASN 名称与描述 |
| prefix / prefixLen | 公告前缀与前缀长度 |
| rir / rirAllocation | RIR 与分配段 |
| prefixes | 相关前缀列表（最多 12 条） |
| classification | customer_access / infrastructure / transit_or_isp / unknown |
| classificationReasons | 分类依据 |

分类说明：

- **customer_access** — 更像接入网/客户地址池，网络所有者≠终端使用机构
- **infrastructure** — 更像基础设施/骨干/托管
- **transit_or_isp** — ISP/聚合段信号；优先 network_owner
- **unknown** — BGP 信号不足，需结合 PTR/被动DNS/HTTP

分类依据：ASN/前缀名称关键字（broadband/residential vs backbone/transit）与前缀长度（/22–/28 典型接入池，≤/16 典型基础设施聚合）。

## whois 模式

数据源：RDAP 多网关，日本地址额外支持 JPNIC port-43 WHOIS。支持 IP 与域名。

### 网关

| 网关 | 说明 |
|------|------|
| auto | 先 rdap.org，再 JPNIC RDAP，APNIC，JPNIC WHOIS，ARIN，RIPE |
| jpnic | 强制日本网关 |
| apnic | 亚太网关 |
| arin | 北美网关 |
| ripe | 欧洲/非洲网关 |
| rdap | rdap.org 为主 |

### 返回字段

| 字段 | 说明 |
|------|------|
| objectClassName | 对象类型（domain / ip network） |
| handle / name | 注册句柄与名称 |
| country / status | 注册国家与状态 |
| startAddress / endAddress | IP 段起止地址 |
| events | 创建/更新/转移等关键事件 |
| entities | 注册者/管理员/技术/abuse 实体 |
| abuseEmail / abuseName | Abuse 联系方式 |
| registrantName / registrantEmail | 注册者信息 |
| nameservers | 域名服务器列表 |

日本 IP 在 APNIC 往往数据较薄，建议使用 `gateway=jpnic`。

## all 模式

并行执行 BGP 与 RDAP/WHOIS（任一失败不影响另一方），返回：

| 字段 | 说明 |
|------|------|
| route | BGP 摘要（失败时省略） |
| registration | RDAP/WHOIS 摘要（失败时省略） |
| assessment.routeOwner | 路由公告方（ASN 名称） |
| assessment.networkOwner | 注册方（registrant / name / handle） |
| assessment.consistent | 两侧主体名称是否一致（无法比较时省略） |
| assessment.notes | 交叉研判提示，如名称不一致、RIR 不一致、接入网特征 |
| assessment.hint | 综合结论提示 |
| sources | 各数据源成功/失败/跳过状态 |

研判原则：

- 接入网（customer_access）或托管段的“网络所有者”不等于终端使用机构
- 路由公告方与注册方不一致时，优先按接入网/转售/托管研判
- 单一来源不足以认定归属，应结合 PTR、被动 DNS、HTTP 指纹

## 配置

当前没有可配置项。配置文件中的 `redteam.net-lookup` 是预留分组，先留空即可：

```json
{
  "redteam": {
    "net-lookup": {}
  }
}
```

## 注意

- `bgp` 模式仅支持 IPv4；IPv6 在 `all` / `auto` 下会跳过 BGP 并继续 RDAP
- `raw=true` 需要明确 `mode=bgp` 或 `mode=whois`；`all` 模式返回摘要
- BGPView、RDAP 与 JPNIC 均无需 API Key
