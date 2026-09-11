---
name: whois-rdap
description: 通过 RDAP/WHOIS 查询 IP/域名注册信息，支持自动选择最优网关。
---

# WHOIS/RDAP

通过 RDAP/WHOIS 查询 IP 地址或域名的注册信息，包括注册者、注册商、日期、状态等。

## 参数

| 参数 | 类型 | 说明 |
|------|------|------|
| target | string | IP、域名或 URL |
| input | string | 同 target |
| gateway | string | auto / jpnic / apnic / arin / ripe / rdap，默认 auto |
| raw | boolean | true 返回完整 RDAP JSON 或 WHOIS 原文 |
| timeout_seconds | number | 超时秒数，默认 20 |

## 示例

```bash
# 查询域名注册信息
Find who owns example.com

# 查询 IP 注册信息
Lookup IP registration for 8.8.8.8

# 强制使用 JPNIC 网关
Query WHOIS for 103.0.0.0/8 with gateway=jpnic
```

## 支持的对象类型

- **域名** - 通过 rdap.org / Verisign 查询
- **IP 地址** - 通过 APNIC/ARIN/RIPE RDAP 或 JPNIC WHOIS 查询

## RDAP 网关说明

| 网关 | 说明 |
|------|------|
| auto | 默认，先 rdap.org，再 JPNIC RDAP，APNIC，JPNIC WHOIS，ARIN，RIPE |
| jpnic | 强制日本网关，先 JPNIC RDAP |
| apnic | 亚太网关 |
| arin | 北美网关 |
| ripe | 欧洲/非洲网关 |
| rdap | rdap.org 为主 |

## 返回字段

| 字段 | 说明 |
|------|------|
| objectClassName | 对象类型（domain / ip network） |
| handle | 注册句柄 |
| name | 注册名称 |
| country | 注册国家 |
| status | 状态 |
| events | 关键事件（创建/更新/转移等） |
| entities | 关联实体（注册者/管理员/技术/ abuse） |
| abuseEmail | Abuse 联系邮箱 |
| registrantName | 注册者名称 |
| nameservers | 域名服务器列表 |

## JPNIC WHOIS 特殊处理

- 自动解析 JPNIC 格式的 WHOIS 文本输出
- 提取 Network Number / Name / Type / Organization 等字段
- 处理 JPNIC 特有的联系人和 abuse 信息

## 日本 IP 地址

日本分配的 IP 在 APNIC 往往数据较薄，建议使用 `gateway=jpnic` 获取更完整的信息。
