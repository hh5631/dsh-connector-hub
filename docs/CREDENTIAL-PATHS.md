# 凭据获取路径（浏览器优先）

连接器「连不上」的绝大多数原因不是协议不对，而是**用户拿不到凭据**。
本文档说明插件为此提供的三条路径，以及各自的适用边界。

## 为什么要做这件事

早期实现只有两种结局：要么服务支持 OAuth 动态客户端注册（DCR），一键浏览器授权；
要么用户被丢给 `connector_hub_configure` 自己填 Token。中间地带——

- 支持 OAuth 但**不支持 DCR**（GitHub 就是典型：`github.com/login/oauth` 的元数据里没有 `registration_endpoint`）；
- 根本没有 OAuth，只有 API Key（高德地图 `mcp.amap.com`，无 key 直接返回 `INVALID_USER_KEY`）；
- 用户本机其实**已经登录**了官方 CLI（`gh`），token 就在那儿；

——全部变成了死路。用户看到的是「需要凭据」，而不知道下一步该做什么。

## 路径一：OAuth 浏览器授权（默认）

适用于服务同时提供 `authorization_endpoint`、`token_endpoint` **和** `registration_endpoint`。

流程：发现受保护资源元数据 → 发现授权服务器元数据 → 动态注册客户端 → 启动本机
loopback 回调 → 打开浏览器 → 用户登录并同意 → 用 code 换 token。

代码：`lib/connectors/oauth-connector.js` 的 `oauthAuthorize()`。
配置：目录卡片里 `auth.mode: oauth2-pkce`。

## 路径二：自备 OAuth App（无 DCR 时的兜底）

服务不提供 `registration_endpoint` 时，DCR 这条路走不通，但标准授权码流程本身仍然可用——
前提是有一个**已登记**的客户端。做法是让用户在自己的账号里登记一个 OAuth App，
把 `client_id`（机密客户端再加 `client_secret`）交给插件：

```js
connector_hub_connect({
  connectorId: 'github',
  oauthClient: { clientId: 'Iv1.xxxx', clientSecret: '...' }, // secret 可选
})
```

要点：
- `redirect_uri` 要填 **127.0.0.1 的 loopback 地址**（插件启动回调监听后会在日志里打出来）；
- 插件不会自动帮你登记客户端，也不会猜任何 client_id；
- 错误被归类为 `recoverable: 'provide-oauth-client'`，面板据此弹出输入框而不是显示死路。

代码：`resolveOAuthClient()`。

## 路径三：设备码流程（RFC 8628）

服务既不支持 DCR，又不想让用户登记 App 时，如果它提供 `device_authorization_endpoint`，
就走设备码：插件申请一个短码，用户在任何浏览器里打开验证页输入即可，**无需本机回调端口、
无需 redirect_uri 白名单**。

流程选择是自动的：

| 条件 | 选用的流程 |
| --- | --- |
| 显式传 `oauthFlow` | 按传入值 |
| 有设备码端点且**无** DCR | `device-code` |
| 其余情况 | `authorization-code` |

轮询语义按 RFC 8628 §3.5 实现：`authorization_pending` 继续等、`slow_down` 加长间隔、
`expired_token` / `access_denied` 立即终止。

代码：`lib/oauth.js` 的 `requestDeviceCode()` / `pollDeviceToken()`。

## 路径四：复用本机 CLI 登录态

与其让用户再创一个 PAT，不如复用他已经同意过的 OAuth 授权——`gh auth token` 输出的
`gho_...` 本质就是 OAuth token，只是由 CLI 托管。

安全边界（不可放宽）：

1. **只读**：只执行 `gh auth token` / `glab auth status --show-token` 这类只读命令，绝不改 CLI 配置；
2. **白名单**：只探测 `gh` / `glab` / `az`，不接受任意命令；
3. **不经 shell**：`spawn(bin, argv)` 直接传参，无注入面；
4. **不落日志**：token 只在内存中传给连接记录，日志与返回值里一律没有；
5. **失败降级**：探测失败返回「不可用」，绝不抛异常打断连接流程。

工具：`connector_hub_cli_auth_status`（只报告谁能用）、`connector_hub_reuse_cli_auth`（实际复用）。

代码：`lib/cli-auth-reuse.js`。

## 路径五：API Key 申请指引

对只有 API Key 的服务（高德、Stripe 等），插件不再只丢一句「需要凭据」，而是给出
**可点击的官方申请页**。解析优先级：

1. 目录声明的 `auth.credentialHelpUrl`；
2. 目录的 `homepage`；
3. 内置已知厂商表（`lib/credential-guide.js`）；
4. 都没有 → 返回 `undefined`，**绝不编造链接**。

面板在「修复凭据 / 连接」对话框里把这条指引渲染成链接，用户点开就能申请。

## 如何新增一个厂商的申请指引

在 `lib/credential-guide.js` 的 `CREDENTIAL_GUIDES` 里加一条：

```js
'service-id': {
  url: 'https://官方申请页',
  label: '去 X 创建 API Key',
  note: '申请时要注意的坑（应用类型、必开 API、scope 等）。',
},
```

只收录**有稳定官方文档页**的服务；URL 必须人工核实，不接受猜测。

## 已知限制

- **GitHub 的 DCR 缺失是服务端策略**：`github.com/login/oauth` 的元数据确实没有
  `registration_endpoint`，这不是抓取失败。路径二/三/四都是绕行方案，不是修复 GitHub。
- 设备码流程要求服务支持 `urn:ietf:params:oauth:grant-type:device_code`；不支持的会在
  `device-authorization` 阶段明确失败。
- 复用的 CLI token 由 CLI 自己负责刷新；插件不再介入，因此 CLI 登出后连接会失效，
  需要重新 `reuse_cli_auth`。
