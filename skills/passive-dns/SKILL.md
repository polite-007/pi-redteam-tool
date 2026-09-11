---
name: passive-dns
description: 被动 DNS/证书透明度查询，域名查 crt.sh，IP 查历史关联域名。
---

# Passive DNS

被动 DNS / 证书透明度查询工具，用于发现 IP 与域名历史关联关系。

## 参数

| 参数 | 类型 | 说明 |
|------|------|------|
| target | string | IP、域名或 URL |
| input | string | 同 target |
| timeout_seconds | number | 超时秒数，默认 25 |
| limit | number | 返回域名上限，默认 100 |

## 示例

```bash
# 查找子域名
Find all subdomains of example.com ever resolved

# IP 反查域名
Find domains associated with IP 1.2.3.4

# 扩大范围
Search passive DNS for *.example.com with limit=200
```

## 数据源

### 域名查询
- **crt.sh** - 证书透明度日志，查询该域名下所有证书关联的子域名

### IP 查询
- **SecurityTrails** - 有 API Key 时使用（更全面）
- **HackerTarget** - 无 Key 时回退使用
- **crt.sh** - 也会尝试 IP 身份查询（通常数据较少）

## 返回字段

| 字段 | 说明 |
|------|------|
| target | 原始输入 |
| host | 解析后的主机 |
| kind | domain 或 ip |
| domains | 关联域名列表 |
| count | 域名数量 |
| sources | 数据来源详情 |
| configuredSecurityTrails | 是否配置了 SecurityTrails Key |
| hint | 无数据时的提示信息 |

## 配置

SecurityTrails API Key（可选，提升 IP 反查质量）：

```bash
export REDTEAM_PASSIVE_DNS_KEY="your-securitytrails-key"
```

或在 `config/config.yaml` 中配置 `passive-dns.key`。

## 使用场景

- 发现目标的所有子域名
- 发现同一 IP 上托管的多个站点
- 关联看似无关的域名到同一组织
- 发现历史曾使用的域名/子域名
