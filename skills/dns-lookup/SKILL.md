---
name: dns-lookup
description: 查询 DNS 记录（A/AAAA/PTR/NS/MX/TXT/CNAME/SOA/SRV/CAA），无需 API Key。
---

# DNS Lookup

查询 DNS 记录，支持 A/AAAA/PTR/NS/MX/TXT/CNAME/SOA/SRV/CAA 等记录类型。无需外部 API Key，直接使用系统 DNS 或指定解析器。

## 参数

| 参数 | 类型 | 说明 |
|------|------|------|
| target | string | IP、域名或 URL |
| input | string | 同 target |
| types | string[] | 记录类型，默认 A,AAAA,PTR,NS,MX,TXT,CNAME,SOA；可选 SRV,CAA |
| nameserver | string | 可选 DNS 服务器 IP（如 8.8.8.8 / 1.1.1.1），省略用系统解析器 |

## 示例

```bash
# 查询 A 记录
Look up DNS A record for example.com

# 查询 MX 记录（邮件服务器）
Find mail servers for example.com

# 使用指定 DNS 服务器
Query DNS for example.com using 8.8.8.8

# PTR 反向查询
Resolve IP 8.8.8.8 for hostname
```

## 支持的记录类型

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

## 特性

- Windows 系统解析器异常时自动回退到 8.8.8.8
- IP 可做 PTR 反向查询
- IPv6 地址支持 PTR 查询
