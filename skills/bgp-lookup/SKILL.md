---
name: bgp-lookup
description: 查询 IP 的 BGP 前缀/ASN，通过启发式区分接入网与基础设施，辅助研判 IP 归属。
---

# BGP Lookup

查询 IP 的 BGP 前缀/ASN，通过 BGPView API 获取信息，并启发式区分 `customer_access`（接入网）vs `infrastructure`（基础设施），辅助研判 IP 归属。

## 参数

| 参数 | 类型 | 说明 |
|------|------|------|
| ip | string | IPv4 地址 |
| target | string | IPv4 或含 IP 的 URL |
| input | string | 同 target |
| raw | boolean | 返回 BGPView 原始 JSON，默认 false |
| timeout_seconds | number | 超时秒数，默认 20 |

## 示例

```bash
# 查询 AS 信息
Find AS information for 8.8.8.8

# 查询 Google DNS 的 BGP 信息
Lookup BGP data for 8.8.8.8
```

## 返回字段

| 字段 | 说明 |
|------|------|
| ip | 查询的 IP |
| asn | ASN 编号（如 AS15169） |
| asnNumber | ASN 数字 |
| asnName | ASN 名称 |
| asnDescription | ASN 描述 |
| prefix | 前缀（如 8.8.8.0/24） |
| prefixLen | 前缀长度 |
| classification | 分类：customer_access / infrastructure / transit_or_isp / unknown |
| classificationReasons | 分类依据 |
| rir | RIR 名称（如 ARIN、APNIC） |

## 分类说明

- **customer_access** - 更像接入网/客户地址池，网络所有者≠终端使用机构
- **infrastructure** - 更像基础设施/骨干/托管，可偏向 org_is_infra_provider
- **transit_or_isp** - ISP/聚合段信号，慎下 org_uses_ip，优先 network_owner
- **unknown** - BGP 信号不足，需结合 PTR/被动DNS/HTTP

## 分类依据

- ASN/前缀名称/描述中的关键字（broadband/residential vs backbone/transit）
- 前缀长度：/22-/28 典型接入池，≤/16 典型基础设施聚合
