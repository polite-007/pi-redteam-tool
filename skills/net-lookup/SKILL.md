---
name: net-lookup
description: 网络归属查询：RIPEstat/Team Cymru 路由信息 + RPKI + RDAP/WHOIS 注册信息 + Shodan InternetDB。
---

# Network Lookup

一个工具，三个查询模式，用于回答“这个 IP / 域名是谁的”：

- **bgp** — 路由视角：ASN、前缀、接入网 vs 基础设施分类、RPKI 状态
- **whois** — 注册视角：IP / 域名注册信息（RDAP + JPNIC WHOIS）
- **all** — 并行执行以上两者，输出合并后的归属研判，并可附加主机暴露信息

`mode=auto`（默认）在 IP 上使用 `all`，在域名上使用 `whois`。

## 参数

| 参数 | 类型 | 模式 | 说明 |
|------|------|------|------|
| target | string | 全部 | IP、域名或 URL |
| input | string | 全部 | 同 target |
| ip | string | bgp | IP 别名 |
| mode | string | 全部 | `auto`（默认）/ `bgp` / `whois` / `all` |
| gateway | string | whois | `auto` / `jpnic` / `apnic` / `arin` / `ripe` / `rdap` |
| raw | boolean | bgp / whois | 返回原始数据；`all` 和 IP 的 `auto` 不支持 |
| enrich | boolean | all | 附加 Shodan InternetDB，默认 true |
| timeout_seconds | number | 全部 | 超时秒数，默认 20 |

## 示例

```bash
# 自动模式：IP 联合路由 + RDAP + InternetDB
Who owns 8.8.8.8?

# 只看路由与 RPKI
Lookup ASN, prefix and RPKI status for 1.2.3.4

# 只查注册信息
Find registration details for example.com

# 强制日本网关
Query WHOIS for 103.2.0.0 with gateway=jpnic

# 关闭 InternetDB 附加信息
Look up 1.2.3.4 without host enrichment
```

## bgp 模式

支持 IPv4 和 IPv6。数据源按优先级：

1. **RIPEstat** `prefix-overview` — ASN、前缀、是否公告、less-specific 对齐
2. **Team Cymru** `origin.asn.cymru.com` / `origin6.asn.cymru.com` — RIR、国家、分配日期、ASN 描述（通过 DoH TXT，极轻量）
3. **BGPView** — RIPEstat 失败时兜底

RIPEstat 成功时会再查 `rpki-validation`：

| RPKI 状态 | 含义 |
|-----------|------|
| `valid` | 前缀与 origin ASN 有有效 ROA |
| `invalid_asn` | 有 ROA，但 origin ASN 不匹配 |
| `invalid_length` | 前缀长度超出 ROA 的 maxLength |
| `unknown` | 没有覆盖该前缀的 ROA |

返回字段：

| 字段 | 说明 |
|------|------|
| source | `ripestat` / `cymru` / `bgpview` |
| asn / asnNumber | ASN 编号 |
| asnName / asnDescription | ASN 名称与描述 |
| prefix / prefixLen | 公告前缀与前缀长度 |
| announced | 是否处于公告状态 |
| lessSpecific | 是否被对齐到 less-specific 前缀 |
| rir / rirAllocation | RIR 与分配段 |
| rpki | `{ status, validatingRoas }` |
| classification | customer_access / infrastructure / transit_or_isp / unknown |
| classificationReasons | 分类依据 |

分类说明：

- **customer_access** — 更像接入网/客户地址池，网络所有者≠终端使用机构
- **infrastructure** — 更像基础设施/骨干/托管
- **transit_or_isp** — ISP/聚合段信号；优先 network_owner
- **unknown** — 信号不足，需结合 PTR/被动DNS/HTTP

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

并行执行路由查询、RDAP/WHOIS 和（默认）InternetDB，任一失败不影响其他部分。

| 字段 | 说明 |
|------|------|
| route | 路由摘要（含 `source` 与 `rpki`，失败时省略） |
| registration | RDAP/WHOIS 摘要（失败时省略） |
| internetdb | Shodan InternetDB：`ports`、`hostnames`、`cpes`、`tags`、`vulns` |
| assessment.routeOwner | 路由公告方（ASN 名称） |
| assessment.networkOwner | 注册方（registrant / name / handle） |
| assessment.consistent | 两侧主体名称是否一致（无法比较时省略） |
| assessment.notes | 交叉研判提示，如名称不一致、RIR 不一致、接入网特征、less-specific 对齐 |
| assessment.hint | 综合结论提示 |
| sources | 各数据源成功/失败/跳过状态 |

研判原则：

- 接入网（customer_access）或托管段的“网络所有者”不等于终端使用机构
- 路由公告方与注册方不一致时，优先按接入网/转售/托管研判
- `lessSpecific=true` 表示 RIPEstat 把 IP 对齐到了上层聚合段，ASN 归属需谨慎
- 单一来源不足以认定归属，应结合 PTR、被动 DNS、HTTP 指纹

## 配置

当前没有必需配置项。配置文件中的 `redteam.net-lookup` 是预留分组：

```json
{
  "redteam": {
    "net-lookup": {}
  }
}
```

## 速率与可用性

- RIPEstat 免费、无 Key；8 并发/IP，长期超过 1000 次/天建议登记 `sourceapp`
- Team Cymru 是社区服务，免费且无 Key；脚本通过 DoH 查询 TXT，避免依赖本地 53 端口
- BGPView 仅作为兜底，公共 API 偶有不稳定
- Shodan InternetDB 免费、无 Key、非商业使用；数据每周更新，`vulns` 为启发式结果需复核
- `enrich=false` 可关闭 InternetDB，减少一次外部请求
