---
name: dns-lookup
description: DNS 查询：records 模式支持系统解析器与 DoH/DNSSEC，passive 模式聚合 crt.sh、Wayback、OTX 等免费源。
---

# DNS Lookup

一个工具，两种模式：

- **records**（默认）— 主动查询 DNS 记录，使用系统解析器、指定 nameserver 或 DNS-over-HTTPS；DoH 额外返回 DNSSEC 验证状态。
- **passive** — 被动 DNS：crt.sh、Wayback CDX、AlienVault OTX，IP 反查另有 SecurityTrails（可选 Key）与 HackerTarget。

## 参数

| 参数 | 类型 | 模式 | 说明 |
|------|------|------|------|
| target | string | 全部 | IP、域名或 URL |
| input | string | 全部 | 同 target |
| mode | string | 全部 | `records`（默认）或 `passive` |
| types | string[] | records | 记录类型，默认 A,AAAA,PTR,NS,MX,TXT,CNAME,SOA；可选 SRV,CAA |
| nameserver | string | records | 指定 DNS 服务器 IP（如 8.8.8.8）；设置后忽略 transport |
| transport | string | records | `auto`（默认）\| `system` \| `doh` |
| doh_server | string | records | `auto`（默认）\| google \| cloudflare \| quad9 \| alidns \| doh.pub \| URL |
| sources | string[] | passive | `crt.sh`、`otx`、`wayback`、`all`；默认域名为 crt.sh+wayback，IP 为 crt.sh+otx |
| timeout_seconds | number | 全部 | records 的 DoH 默认 12 秒；passive 默认 25 秒 |
| limit | number | passive | 返回域名上限，默认 100 |

## 示例

```bash
# 主动：A 记录
Look up DNS A record for example.com

# 主动：DoH + DNSSEC
Resolve example.com A record via DoH

# 主动：指定解析器
Query DNS for example.com using 8.8.8.8

# 主动：IPv6 PTR
Resolve IP 2001:db8::1 for hostname

# 被动：子域名
Find all subdomains of example.com ever resolved

# 被动：只查 OTX（IP 反查）
Find domains associated with IP 1.2.3.4 using OTX

# 被动：扩大范围
Search passive DNS for *.example.com with limit=200
```

## records 模式

支持的记录类型：

| 类型 | 说明 | 适用对象 |
|------|------|----------|
| A | IPv4 地址 | 域名 |
| AAAA | IPv6 地址 | 域名 |
| PTR | 指针记录（反向查询） | IP |
| NS | 域名服务器 | 域名 |
| MX | 邮件交换记录 | 域名 |
| TXT | 文本记录 | 域名 |
| CNAME | 规范名称别名 | 域名 |
| SOA | 授权起始记录 | 域名 |
| SRV | 服务定位记录 | 域名 |
| CAA | 证书授权访问 | 域名 |

### 传输方式

| transport | 行为 |
|-----------|------|
| `auto` | 先系统解析；出现 ECONNREFUSED / ETIMEDOUT / ENOTFOUND / EAI_AGAIN / ESERVFAIL 时改用 DoH |
| `system` | 只用系统解析；传输失败时回退 8.8.8.8 |
| `doh` | 只用 DoH，返回 `dnssec.authenticated` |

DoH 的 `auto` 服务器顺序：`doh.pub` → AliDNS → Google → Cloudflare。整个回退链共享同一个超时预算，不会把超时乘以服务器数量。

### 返回字段

| 字段 | 说明 |
|------|------|
| transport | `system` 或 `doh` |
| nameserver | 使用的解析器（system / IP / fallback） |
| dohServer | DoH 实际命中的服务器（仅 DoH） |
| dnssec | `{ authenticated, checked }`（仅 DoH）；来自 AD 标志 |
| records | 各记录类型的结果 |
| errors | 失败类型及错误码 |

## passive 模式

### 数据源

| 源 | 适用 | 说明 |
|----|------|------|
| crt.sh | 域名 / IP | 证书透明度日志中的证书域名 |
| Wayback CDX | 域名 | 从历史 URL 提取主机名，可发现未进 CT 的子域 |
| AlienVault OTX | 域名* / IP | 历史被动 DNS；**域名接口现在需要认证**，IP 接口仍可匿名 |
| SecurityTrails | IP | 配置 `securityTrailsKey` 时优先使用 |
| HackerTarget | IP | 无 SecurityTrails 或结果为空时回退 |

> \* 域名路径的 OTX 默认不启用；显式传 `sources=["otx"]` 时会返回认证错误。

默认源：

- 域名：`crt.sh` + `wayback`
- IP：`crt.sh` + `otx`

显式传 `sources` 会覆盖默认；`sources=["all"]` 启用三个免费源。

### 返回字段

| 字段 | 说明 |
|------|------|
| mode | `passive` |
| target / host / kind | 原始输入、解析后的主机、domain/ip |
| domains | 去重后的关联域名列表 |
| count | 域名数量 |
| sources | 每个源的 `recordCount` 与 `error` |
| configuredSecurityTrails | 是否配置了 SecurityTrails Key |
| hint | IP 无结果时的提示 |

## 配置

```json
{
  "redteam": {
    "dns-lookup": {
      "securityTrailsKey": "your-securitytrails-key",
      "dohServer": "auto"
    }
  }
}
```

- `securityTrailsKey`（可选）：提升 IP 反查质量；未配置时回退 HackerTarget。
- `dohServer`（可选）：DoH 预设或完整 URL，默认 `auto`。

> 环境变量 `REDTEAM_PASSIVE_DNS_KEY` **不再读取**；旧的 `redteam.passiveDns` 分组也不再读取，请改用 `redteam.dns-lookup`。

## 速率与可用性

- Wayback CDX 建议串行、低频调用；结果可能很大，脚本已设置 `limit` 与 `collapse=urlkey`。
- OTX 未认证约 1000 次/小时，429 时请稍后重试。
- Google / Cloudflare DoH 在部分网络不可达；`auto` 会优先尝试 `doh.pub` 与 AliDNS。
