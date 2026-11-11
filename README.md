# 连接器（Connector）

> DeepSeek Harness 的 MCP 连接控制台。基于 `dsh-mcp-connector` v0.2.97 完整 fork 而来，**独立包名、独立路由、独立存储域**，可与原插件同时安装运行。

## 为什么会有这个插件

原版健康检查只做一次 MCP `initialize` 握手。部分网关（典型如 AceDataCloud 的 Seedance / Kling）**在握手层不校验 Bearer Token**，直到真实业务方法才返回 `The token is invalid`。结果是：

```
面板显示「已连接 / ok」 → 用户点生成视频 → 报错 → 回头查状态还是 ok
```

连接器的核心优化就是把这两个状态分开。

## 相对原版的改动

### 1. 深度健康探测（三态）
`lib/deep-health.js`：握手成功后，先 `tools/list` 拿到真实工具清单，再挑一个**只读查询类**工具（如 `seedance_get_task`，名字含 get/list/find/search/status，且排除 generate/create/delete 等动作类），按 inputSchema 必填项填占位参数发起一次调用，绝不产生计费、不创建资源。这是经真实网关验证后修正的策略——虚构工具名会被网关直接回 `Unknown tool` 而**不校验 token**，抓不到失效凭据。

| 服务端返回 | 判定 |
|---|---|
| 401 / 403 / `token is invalid` / `invalid api key` / `unauthorized` … | `credential-invalid`（覆盖握手的假阳性） |
| 业务调用正常返回 / 参数校验错误 / `method not found` / `-32601` / `-32602` | `verified`（鉴权已放行，业务通道可用） |
| 网络失败 / 超时 / 无法归类 | `unknown`（不把成功降级为失败） |

探针有独立超时、64 KiB 响应上限、URL 安全校验，结果只存内存、不落库、不进 SSE 事件流。

### 2. 失效凭据一键修复
新增 `repairCredentials` API（Web 白名单 + 对话工具 `connector_hub_repair_credentials` + 面板「修复凭据」按钮）：

- **只替换** Token / API Key，保留 URL、`serverName`、作用域、注入模式、启停状态等全部其余配置；
- 写入后立刻跑一次业务级复验，新凭据仍失效就明确报错、不误报成功；
- 诊断结果带结构化 `remediation: { kind, api, label, connectionKey, connectorId }`，UI 直接映射成按钮。

### 3. JWT 过期预警
`extractTokenExpiry()` 读取静态 Bearer / API Key 的 `exp`，在 `status` 里输出 `credential: { expiresAt, expiringSoon, expired }`（响应派生，**不落库**）。面板显示「凭据即将过期 / 已过期」徽标。

### 4. 全新控制台界面
`ui/index.html` + `ui/hub.css` + `ui/hub.js` 重写，替换原版的三 Tab 市场面板：

- 深色石板底的「信号带」总览：绿=业务已验证、琥珀=待确认、红=凭据失效、灰=未启用；
- 每条连接一行，颜色边条即状态，显示真实业务就绪态而非握手态；
- 失效行直接出现「修复凭据」主按钮；
- 连接 / 目录 / 工具三视图，SSE invalidation + 按需拉取，保留工作区上下文 postMessage 协议；
- 响应式、`prefers-reduced-motion`、键盘焦点可见、`</head>` 语言注入契约、CSP 全部兼容。

### 5. 隔离（与原插件共存）
逐项改名，确保零冲突：

| 项 | 原版 | Hub |
|---|---|---|
| 包名 | `dsh-mcp-connector` | `dsh-connector-hub` |
| Cordis 插件名 | `mcp-connector` | `connector-hub` |
| 存储域 | `mcp_connector` | `connector_hub` |
| 对话工具前缀 | `mcp_connector_*` | `connector_hub_*` |
| Web 路由 | `/mcp-connector/*` | `/connector-hub/*` |
| mcp-client 条目前缀 | `mcp-<key>` | `hub-<key>` |
| mcp-client serverName | `seedance` | `hub-seedance`（避免与同连接器的原插件实例冲突） |
| 设置命名空间 / 侧边栏 id | `mcp-connector` | `connector-hub` |
| CLI bridge bin | `dsh-mcp-cli-bridge` | `dsh-connector-hub-cli-bridge` |
| iframe 面板全局量 | `__MCP_CONNECTOR_LOCALE__` | `__CONNECTOR_HUB_LOCALE__` |

上游公共资源（目录 registry、Host 的 `@deepseek-ai/dsh-mcp-client`）**保持原名**，因为那是外部依赖而非自身标识。

### 6. 工程化
- 新增 12 个单元测试（`test/deep-health.test.mjs`），覆盖凭据分类、探针三态、无副作用、JWT 提取、诊断兼容；原版包内零测试。
- `npm run lint` 覆盖全部 58 个 JS 文件；`npm run check` = lint + test，全部可跑（原版 lint 引用了 9 个未随包发布的脚本，`npm test` 实跑 0 测试）。
- 新增 `engines.dsh` 版本约束。

## 安装

```bash
# 方式一：预构建 tarball（推荐，无需构建授权）
dsh plugin --profile web add https://github.com/hh5631/dsh-connector-hub/releases/latest/download/dsh-connector-hub.tgz

# 方式二：直接从 GitHub 源码安装
dsh plugin --profile web add github:hh5631/dsh-connector-hub

# 方式三：本地克隆后安装（开发时最常用）
git clone https://github.com/hh5631/dsh-connector-hub.git
dsh plugin --profile web add link:$PWD/dsh-connector-hub
```

安装后**重启 `dsh web`** 才会加载新插件。之后：
- 侧边栏出现「连接器」入口；
- 面板地址 `http://127.0.0.1:3080/connector-hub/ui/`；
- 对话中可用 `connector_hub_health_check`、`connector_hub_repair_credentials` 等工具。

> 界面改动属于 Web 产物的一部分：若从 DSH 源码 checkout 运行 `pnpm run dev:web`，client 插件的 HMR 只对 client-plugin 生效；本插件的 `ui/` 静态资源由 Host 直接读盘，刷新页面即可看到，但新增 bundle 本身需要重启 Host。

## 本地预览界面（无需 DSH Host）

```bash
npm run dev:ui
# 打开 http://127.0.0.1:4173/connector-hub/ui/
```

`scripts/ui-harness.mjs` 提供无凭据的 mock API 与 SSE，内置三种业务就绪态的验收数据，可直接预览信号带与「修复凭据」流程。

## 配置项（`cordis.patch.yml`）

| 配置 | 默认 | 说明 |
|---|---|---|
| `deepHealthProbe` | `true` | 是否启用业务级深度探针；关闭则退回原版握手检查 |
| `deepProbeTimeoutMs` | `6000` | 探针独立超时，不受 5s 握手预算挤压 |
| `credentialExpiryWarnMs` | `86400000` | JWT 过期预警提前量（24h） |
| `entryPrefix` | `'hub'` | mcp-client 条目 id 前缀，**勿改回 `'mcp'`** |
| `frameAncestors` | `['self']` | 面板可嵌入白名单 |

## 兼容性说明

- 存储域保持 `version: 1`，表结构未变；新增字段均为内存/响应派生。
- `connectionState` 枚举未新增，凭据失效复用既有 `reauth`，所有消费方（对话工具、UI、SSE 类别）无需改动。
- SSE 载荷仍只含 `{type,sequence,at}**，不含任何凭据或错误文本**。
- 目录沿用上游 `dsh-mcp-connector-registry`，因此货架内容与原插件一致。

## 许可

MIT（沿用上游）。上游项目：https://github.com/duhu2000/dsh-mcp-connector
