---
name: finalize-result
description: 通用 JSON 对象定稿工具，将结果写入 result.json 文件并清除状态标记。
---

# Finalize Result

通用 JSON 对象定稿工具，将结果写入 `<cwd>/<aiTaskId>.result.json` 文件，并清除 `<cwd>/<aiTaskId>.status` 标记。

## 参数

| 参数 | 类型 | 说明 |
|------|------|------|
| result | object | 要落盘的顶层标准 JSON 对象 |

## 示例

```bash
# 定稿标准结果
Finalize the analysis result as JSON object

# 保存最终判定
Save the asset judgment result
```

## 输入要求

- `result` 必须是顶层 JSON 对象
- 普通文本、命令输出、数组、null、undefined、NaN、Infinity、BigInt、函数、Symbol 或循环引用会被拒绝
- 如果模型传入 `JSON.stringify(...)` 产生的字符串，工具会先解析后落盘

## 输出效果

1. 将结果写入 `<cwd>/<aiTaskId>.result.json`
2. 清除 `<cwd>/<aiTaskId>.status` 标记
3. 返回 terminate=true，建议本批后停止

## 校验规则

工具会验证 JSON 对象：
- 必须是普通 JSON 对象（非 class 实例）
- 不可包含 undefined、BigInt、函数、Symbol
- 不可包含循环引用
- NaN 和 Infinity 会被拒绝
- 所有值必须是标准 JSON 可序列化类型

## 典型使用场景

- 资产判定任务完成后保存结果
- 多工具协作后的最终结果汇总
- 标准化任务输出的持久化

## 错误处理

| 错误 | 原因 |
|------|------|
| result 必须是顶层 JSON 对象 | 传入的不是对象类型 |
| 普通文本/命令输出不能作为最终结果 | 输入为字符串但无法解析为 JSON |
| 缺少 cwd，无法定稿 | 上下文缺少工作目录信息 |
| 无法解析当前 aiTaskId | 缺少 sessionId |
