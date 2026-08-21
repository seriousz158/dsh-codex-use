# dsh-codex-search

独立、默认关闭的 Codex 搜索 Provider（`codex-search`）。它不修改
`codex-chatgpt`、默认模型或全局搜索路由；只有显式设置
`llm-codex-search.enabled: true` 并配置 HTTPS endpoint 后才注册。

远程请求固定经过 SSRF 防护：只允许 HTTP(S)、解析后拒绝 loopback/私网/链路本地
地址，直接连接已解析的公网地址（避免二次 DNS rebinding），拒绝重定向，限制响应
MIME 与字节数。
