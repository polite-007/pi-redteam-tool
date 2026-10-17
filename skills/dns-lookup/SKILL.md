---
name: dns-lookup
description: DNS 查询：mode=records 主动查询记录，mode=passive 被动 DNS/证书透明度。
---

# DNS Lookup

一个工具，两种模式：

- **records**（默认）— 主动查询 DNS 记录，使用系统解析器或指定 nameserver，无需 API Key。
- **passive** — 被动 DNS / 证书透明度：域名查 crt.sh，IP 查历史关联域名。

## 参数

| 参数 | 类型 | 模式 | 说明 |
|------|------|------|------|
| target | string | 全部 | IP、域名或 URL |
| input | string | 全部 | 同 target |
| mode | string | 全部 | `records`（默认）或 `passive` |
| types | string[] | records | 记录类型，默认 A,AAAA,PTR,NS,MX,TXT,CNAME,SOA；可选 SRV,CAA |
| nameserver | string | records | 可选 DNS 服务器 IP（如 8.8.8.8 / 1.1.1.1），省略用系统解析器 |
| timeout_seconds | number | passive | 超时秒数，默认 25 |
| limit | number | passive | 返回域名上限，默认 100 |

## 示例

```bash
# 主动：查询 A 记录
Look up DNS A record for example.com

# 主动：查询 MX 记录（邮件服务器）
Find mail servers for example.com

# 主动：使用指定 DNS 服务器
Query DNS for example.com using 8.8.8.8

# 主动：PTR 反向查询
Resolve IP 8.8.8.8 for hostname

# 被动：查找证书透明度日志中的子域名
Find all subdomains of example.com ever resolved

# 被动：IP 反查域名
Find domains associated with IP 1.2.3.4

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

特性：

- Windows 系统解析器异常时自动回退到 8.8.8.8
- IP 可做 PTR 反向查询
- IPv6 地址支持 PTR 查询

## passive 模式

数据源：

### 域名查询
- **crt.sh** — 证书透明度日志，查询该域名下所有证书关联的子域名

### IP 查询
- **SecurityTrails** — 有 API Key 时使用（更全面）
- **HackerTarget** — 无 Key 时回退使用
- **crt.sh** — 也会尝试 IP 身份查询（通常数据较少）

返回字段：

| 字段 | 说明 |
|------|------|
| mode | `passive` |
| target | 原始输入 |
| host | 解析后的主机 |
| kind | domain 或 ip |
| domains | 关联域名列表 |
| count | 域名数量 |
| sources | 数据来源详情 |
| configuredSecurityTrails | 是否配置了 SecurityTrails Key |
| hint | 无数据时的提示信息 |

### 配置

SecurityTrails API Key（可选，提升 IP 反查质量）。在 `~/.pi/agent/settings.json` 中配置：

```json
{
  "redteam": {
    "dns-lookup": {
      "securityTrailsKey": "your-securitytrails-key"
    }
  }
}
```

未配置时 IP 反查回退到 HackerTarget，响应里 `configuredSecurityTrails` 为 `false`。

> 环境变量 `REDTEAM_PASSIVE_DNS_KEY` **不再被读取**，配置只认配置文件这一个来源。
> 旧的 `redteam.passiveDns` 分组也不再读取，请改用 `redteam.dns-lookup`。

### 使用场景

- 发现目标的所有子域名
- 发现同一 IP 上托管的多个站点
- 关联看似无关的域名到同一组织
- 发现历史曾使用的域名/子域名
