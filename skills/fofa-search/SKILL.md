---
name: fofa-search
description: 通过 FOFA API 查询网络空间资产，返回 IP、端口、协议、国家、ASN、证书等信息。
---

# FOFA Search

通过 FOFA API 查询网络空间资产，支持 FOFA 查询语法，返回 IP、端口、协议、国家、ASN、ORG、证书等字段。

## 参数

| 参数 | 类型 | 说明 |
|------|------|------|
| query | string | FOFA 查询语法，如 `ip="1.2.3.4"` 或 `domain="example.com"` |
| target | string | IP、域名或 URL，自动构建默认查询 |
| input | string | 同 target |
| page | number | 页码，默认 1 |
| size | number | 每页条数，默认 20（含 banner/header/cert 时自动下调上限） |
| fields | string | 逗号分隔返回字段，省略则用 preset/default |
| preset | string | 字段预设: `default`(官方34字段) 或 `light`(去掉 header/banner/cert 原文) |

## 示例

```bash
# 查询域名资产
Find nginx servers in China

# 查询 IP 资产
Search for all services on 1.2.3.4

# 自定义字段
query="port=80" size=50 fields="ip,port,country,title"
```

## 配置

需要设置 FOFA API Key：

```bash
export REDTEAM_FOFA_KEY="your-fofa-key"
export REDTEAM_FOFA_EMAIL="your-email@example.com"
```

或在 `config/config.yaml` 中配置 `fofa.key`。

## FOFA 查询语法参考

- `ip="x.x.x.x"` - IP 精确查询
- `domain="example.com"` - 域名查询
- `host="example.com"` - 主机查询
- `port="80"` - 端口查询
- `country="CN"` - 国家查询
- `asn="12345"` - ASN 查询
- `cert="example.com"` - 证书查询
- `title="nginx"` - 标题查询
- `server="nginx"` - 服务器类型查询
