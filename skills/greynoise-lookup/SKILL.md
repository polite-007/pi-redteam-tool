---
name: greynoise-lookup
description: 查询 GreyNoise 威胁情报：噪声/扫描器分类、RIOT 业务情报、IP 详情。
---

# GreyNoise Lookup

查询 GreyNoise 威胁情报 API，返回 IP 的噪声/扫描器分类、RIOT 业务情报、相关元数据。

## 参数

| 参数 | 类型 | 说明 |
|------|------|------|
| target | string | IPv4 地址 |
| input | string | IPv4 或含 IP 的 URL |
| ip | string | IPv4 地址 |
| quick | boolean | true 时使用轻量响应（需 Key） |
| raw | boolean | true 返回完整 API JSON，默认摘要 |
| force_community | boolean | 强制只用 Community 接口 |
| timeout_seconds | number | 超时秒数，默认 20 |

## 示例

```bash
# 检查 IP 威胁情报
Check 1.2.3.4 in threat intelligence

# 查看是否已知扫描器
Is 8.8.8.8 in GreyNoise noise dataset
```

## 返回字段

| 字段 | 说明 |
|------|------|
| ip | 查询的 IP |
| noise | 是否在噪声数据集（互联网扫描器） |
| riot | 是否在 RIOT 数据集（已知业务服务） |
| classification | 分类：benign / malicious / unknown |
| name | 扫描器/恶意软件名称 |
| tags | 相关标签 |
| bot | 是否为僵尸网络 |
| vpn | 是否为 VPN |
| tor | 是否为 Tor 出口 |
| metadata | AS/ORG/城市/国家等元数据 |

## API 优先级

1. 有 API Key 时优先使用 `/v3/ip`（上下文更全）
2. 无 Key 或鉴权失败时使用 Community 接口
3. `force_community=true` 强制只用 Community

## 配置

需要设置 GreyNoise API Key：

```bash
export REDTEAM_GREYNOISE_KEY="your-greynoise-key"
```

或在 `config/config.yaml` 中配置 `greynoise.key`。

## 限流说明

Community 接口有日/周配额限制，超限会返回 429 错误，建议升级套餐或稍后重试。
