---
name: httpx-probe
description: HTTP 探测工具，调用本机 ProjectDiscovery httpx，获取标题、TLS、技术栈、ASN 等信息。
---

# HTTPX Probe

通用 HTTP 请求与探测工具，调用本机 ProjectDiscovery httpx（JSONL 格式），获取标题、TLS 证书、技术栈、ASN、CDN 判定等信息。

## 参数

| 参数 | 类型 | 说明 |
|------|------|------|
| target | string | URL、域名或 IP |
| input | string | 同 target |
| timeout_seconds | number | 超时秒数，默认 15 |
| scheme | string | 强制 http 或 https |
| method | string | HTTP 方法，默认 GET；支持 POST/PUT/PATCH/DELETE/OPTIONS |
| body | string | UTF-8 请求体，最大 1MB；GET/HEAD 不允许 |
| follow_redirects | boolean | 跟随重定向，默认 true |
| max_redirects | number | 最大重定向次数，默认 10 |
| proxy | string | http/socks 代理 |
| ports | string | 指定端口，如 `https:443,80` |
| path | string | 请求路径 |
| headers | string[] | 自定义请求头，格式 `Name: Value` |
| threads | number | 并发线程数 |
| rate_limit | number | 请求速率限制 |
| tech_detect | boolean | 技术指纹检测，默认 true |
| tls_grab | boolean | TLS 证书抓取，默认 true |
| asn | boolean | ASN 信息，默认 true |
| cdn | boolean | CDN 判定，默认 true |
| favicon | boolean | Favicon 哈希，默认 true |
| jarm | boolean | JARM 指纹，默认 false |
| http2 | boolean | HTTP/2 支持检测，默认 false |
| include_response_header | boolean | 返回响应头，默认 true |
| include_response | boolean | 返回完整响应体，默认 false |
| body_preview | number/boolean | body 预览字节，默认 4096；false 关闭 |
| no_fallback_scheme | boolean | 不自动切换 scheme |

## 示例

```bash
# 探测 URL
Check HTTP headers and status for https://example.com

# POST 请求
POST JSON to https://api.example.com/endpoint

# 自定义请求头
Probe https://example.com with custom Accept header
```

## 返回字段

| 字段 | 说明 |
|------|------|
| url | 请求 URL |
| status_code | HTTP 状态码 |
| title | 页面标题 |
| server | 服务器类型 |
| content_length | 响应体长度 |
| content_type | 内容类型 |
| final_url | 最终重定向 URL |
| redirect_count | 重定向次数 |
| ip | 目标 IP |
| asn | ASN 信息 |
| cdn | CDN 名称 |
| tls | TLS 证书信息 |
| technologies | 检测到的技术栈 |

## 配置

需要安装 ProjectDiscovery httpx：

```bash
# 安装 httpx
go install github.com/projectdiscovery/httpx/cmd/httpx@latest

# 或指定路径
export REDTEAM_HTTPX_BINARY="/path/to/httpx"
```

代理配置：

```bash
export REDTEAM_HTTPX_PROXY="http://proxy:8080"
```

## 安全特性

- 携带敏感信息（Authorization/Cookie/API Key）的请求不会自动跟随重定向
- 敏感请求头会被脱敏处理
- 请求体不会在重试时重复发送
