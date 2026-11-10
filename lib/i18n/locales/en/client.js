/**
 * 英文词典分片：client（`lib/client.js` 浏览器 bundle）。
 *
 * msgid 为中文原文；缺译文时回退中文原文，不会显示空白。
 * 客户端 bundle 是预编译产物，运行时使用其内置的同名映射（`MESSAGES_EN`）；
 * 这里保留同一份词条，使共享英文词典与客户端一致，并由完备性测试比对两者。
 */
export default {
  "连接器": "Connector",
  "控制侧边栏入口和快捷打开方式。": "Control how the Connector is opened.",
  "在侧边栏显示 连接器": "Show Connector in the sidebar",
  "关闭后只隐藏入口，不影响已连接的 MCP Server 和工具。": "Turning this off only hides the shortcut. Connected MCP servers and tools remain available.",
  "侧边栏入口当前显示。": "The sidebar shortcut is visible.",
  "入口已隐藏，仍可从这里打开 连接器。": "The shortcut is hidden. You can still open Connector here.",
  "当前设置页只读。": "This settings page is read-only.",
  "正在保存…": "Saving…",
  "设置未保存，请重试。": "The setting was not saved. Please try again.",
  "恢复默认": "Reset",
  "打开 连接器": "Open Connector",
  "展开 连接器设置": "Expand Connector settings",
  "收起 连接器设置": "Collapse Connector settings",
  "Prompt 不能为空": "Prompt cannot be empty",
  "请先选择一个工作空间，再使用示例 Prompt": "Select a workspace before using a sample prompt",
  "当前 DSH 版本没有可用的工作区会话创建能力，请升级 DSH 后重试": "This DSH version cannot create workspace sessions. Upgrade DSH and try again.",
  "DSH 对话服务尚未就绪，请稍后重试": "The DSH conversation service is not ready yet. Try again shortly.",
  "无效的 Prompt 请求": "Invalid prompt request",
  "已带入新会话": "Added to a new session",
  "插件 API 不可用，请检查 DSH 宿主兼容性或服务日志": "The plugin API is unavailable. Check DSH host compatibility or the service log.",
  "返回会话": "Back to session",
  "关闭 连接器": "Close Connector",
};
