---
name: wx-article
description: 获取微信公众平台公开文章，提取标题、公众号、发布时间和正文纯文本。
---

# WeChat Article

获取微信公众平台公开文章（https://mp.weixin.qq.com/s/\<mid\>），提取标题、公众号、发布时间和正文纯文本。

## 参数

| 参数 | 类型 | 说明 |
|------|------|------|
| target | string | 文章 URL 或裸 mid |
| input | string | 同 target |
| ua | string | 预设：`chrome`(默认) 或 `wechat`；或任意自定义 UA |
| scene | string | 场景参数，如 `25` / `timeline` |
| from | string | 来源参数，如 `timeline` |
| timeout_seconds | number | 超时秒数，默认 30 |
| max_redirects | number | 最大重定向数，默认 5 |
| extract | boolean | 提取标题/作者/时间/正文，默认 true |
| max_content_chars | number | 正文纯文本截断长度，默认 20000 |
| raw_html | boolean | 额外返回正文 HTML 片段，默认 false |

## 示例

```bash
# 提取文章内容
Fetch the article at https://mp.weixin.qq.com/s/2E5csFBC0kCBV8biVdSatA

# 使用微信 UA
Fetch article with wechat UA
```

## 技术细节

- 默认本机直连 + 真实浏览器 UA（Chrome 桌面 / 微信内置）以绕过 MMLAS 风控拦截
- 不走代理（代理出口 IP 易触发验证码）
- 成功时提取标题/公众号/发布时间/正文纯文本
- 拦截时会返回风控原因（captcha_redirect / captcha_page）

## 返回字段

- `target` - 输入的文章 ID 或 URL
- `url` - 实际请求的 URL
- `final_url` - 最终跳转 URL
- `status` - HTTP 状态码
- `verdict` - ok / blocked / error
- `reason` - 判定原因
- `title` - 文章标题
- `author` - 公众号名称
- `publish_time` - 发布时间
- `content_text` - 正文纯文本
- `content_chars` - 正文字符数
