---
name: fofa-host
description: FOFA Host API：按 IP/host 返回 ASN、ORG、地理信息、端口、协议、产品分类与标签。
---

# FOFA Host

FOFA Host 聚合 API，按 IP/host 返回 ASN、ORG、地理信息、端口、协议、产品分类与标签。

## 参数

| 参数 | 类型 | 说明 |
|------|------|------|
| host | string | IP（通常是 IP） |
| target | string | IP、域名或 URL（取 host） |
| input | string | 同 target |
| detail | boolean | 是否返回端口详情，默认 false |
| timeout_seconds | number | 超时秒数，默认 20 |

## 示例

```bash
# 查询 IP 详情
Lookup host information for 8.8.8.8

# 查询详细端口信息
Get detailed port info for 1.2.3.4 with detail=true
```

## 配置

需要在 `~/.pi/agent/settings.json` 中配置 FOFA API Key：

```json
{
  "redteam": {
    "fofa": {
      "key": "your-fofa-key",
      "baseUrl": "https://fofa.info"
    }
  }
}
```

`baseUrl` 省略时默认 `https://fofa.info`；`key` 缺失时工具返回
`FOFA_NOT_CONFIGURED`，并在错误信息里给出需要编辑的配置文件路径。

> 环境变量 `REDTEAM_FOFA_KEY` / `REDTEAM_FOFA_BASE_URL`
> **不再被读取**，配置只认配置文件这一个来源。

## 注意事项

- 接口限制约 1 次/秒
- `detail=true` 会返回更详细的端口信息
- 需要 FOFA Pro 会员以获取完整数据
