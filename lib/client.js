window.__ModuleLoader__.load({
	id: "dsh-connector-hub",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let react_dom = require("react-dom");

		/** 客户端所需服务：槽位、工作区、会话及对话输入机。 */
		const inject = [
			"slots",
			"sessions",
			"workspaces",
			"conversation"
		];

		/**
		 * 客户端文案国际化。契约与 `lib/i18n` 完全一致：**msgid 就是中文原文**。
		 * 中文路径不查表，msgid 原样返回，因此默认中文界面逐字不变；缺译文时也
		 * 回退中文原文，不会出现空白或英文 key 漏到界面上。
		 *
		 * 客户端 bundle 是预编译产物，不能可靠地 import 服务器侧模块，所以这里
		 * 内置一份映射；`lib/i18n/locales/en/client.js` 保存同一批 msgid，让共享
		 * 英文词典保持完备（两份清单一一对应）。
		 */
		const MESSAGES_EN = Object.freeze({
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
		});
		const DEFAULT_LOCALE = "zh-CN";
		/** 当前生效语言：`apply()` 时解析一次，缺省中文。 */
		let activeLocale = DEFAULT_LOCALE;

		/**
		 * 归一化语言标签：`zh` / `zh_CN` / `zh-Hans-CN` → `'zh-CN'`，
		 * `en` / `en-US` / `EN` → `'en'`；其它一律返回 undefined（由调用方回退）。
		 *
		 * @param {unknown} value 待归一化的标签
		 * @returns {"zh-CN"|"en"|undefined} 支持的语言 id
		 */
		function normalizeLocale(value) {
			if (typeof value !== "string") return undefined;
			const tag = value.trim().toLowerCase();
			if (tag === "") return undefined;
			const [primary] = tag.split(/[-_]/);
			if (primary === "zh") return "zh-CN";
			if (primary === "en") return "en";
			return undefined;
		}

		/**
		 * `{name}` 占位符插值，行为与 `lib/i18n` 的 `interpolate()` 一致：只替换
		 * 调用方显式提供的字段，缺失的占位符保持字面量，便于测试断言漏传参数。
		 *
		 * @param {string} template 含 `{name}` 的模板
		 * @param {Record<string, unknown>} [params] 插值字段
		 * @returns {string} 插值结果
		 */
		function interpolate(template, params) {
			if (typeof template !== "string" || template === "") return "";
			if (params === void 0 || params === null || typeof params !== "object") return template;
			return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (token, name) => {
				const value = params[name];
				return value === void 0 || value === null ? token : String(value);
			});
		}

		/**
		 * 翻译函数。
		 *
		 * @param {string} msgid 中文原文
		 * @param {Record<string, unknown>} [params] `{name}` 插值字段
		 * @returns {string} 当前语言文案；缺译文回退中文原文
		 */
		function t(msgid, params) {
			const key = typeof msgid === "string" ? msgid : String(msgid ?? "");
			const template = activeLocale === DEFAULT_LOCALE
				? key
				: Object.hasOwn(MESSAGES_EN, key) ? MESSAGES_EN[key] : key;
			return interpolate(template, params);
		}

		/**
		 * 读取 DSH 的 `locale` 服务。该服务是**可选**依赖（见
		 * docs/DESIGN-issue-63-sidebar-visibility.md §6.6）：缺失或抛错时返回
		 * undefined，插件照常加载并回退中文，绝不把本地化变成硬依赖。
		 *
		 * @param {any} ctx 客户端上下文
		 * @returns {"zh-CN"|"en"|undefined} 服务报告的语言
		 */
		function localeFromService(ctx) {
			try {
				// 必须用 ctx.reflect.get(name)：`locale` 是可选的嵌套服务，并未写进
				// 本 bundle 的 inject 列表，而 Cordis 的上下文代理在读取未注入的属性时
				// 会直接抛 `cannot get property "locale" without inject`——可选链拦不住。
				// reflect.get 是官方「不要求 inject」的读取入口，服务缺失时返回 undefined，
				// 正好符合 §6.6「本地化不能成为硬依赖」。
				const service = ctx?.reflect?.get?.("locale");
				const active = typeof service?.getLocale === "function" ? service.getLocale()?.active : undefined;
				return normalizeLocale(active);
			} catch (error) {
				console.warn("[connector-hub] locale service unavailable:", error);
				return undefined;
			}
		}

		/**
		 * 生效语言：只认宿主语言服务。服务缺失或抛错时回退中文默认——本地化
		 * 能力不能成为 bundle 的硬依赖（docs/DESIGN-issue-63-sidebar-visibility.md §6.6）。
		 * 由于参数缺失时默认值就是中文，面板 iframe 的 URL 也会保持既有字面量
		 * `/connector-hub/ui/`，不带查询串。
		 *
		 * @param {any} ctx 客户端上下文
		 * @returns {"zh-CN"|"en"} 生效语言
		 */
		function resolveLocaleId(ctx) {
			return localeFromService(ctx) ?? DEFAULT_LOCALE;
		}

		/**
		 * 面板 URL：只有非默认语言才追加 `?locale=`，中文保持既有字面量
		 * `/connector-hub/ui/`（面板自身也回退中文）。
		 *
		 * @param {unknown} locale 语言（可传未归一化的标签）
		 * @returns {string} iframe 地址
		 */
		function marketIframeSrc(locale) {
			const base = window.location.origin + "/connector-hub/ui/";
			const normalized = normalizeLocale(locale);
			return normalized === void 0 || normalized === DEFAULT_LOCALE
				? base
				: `${base}?locale=${encodeURIComponent(normalized)}`;
		}

		const PROMPT_REQUEST_TYPE = "connector-hub:start-session";
		const PROMPT_RESULT_TYPE = "connector-hub:start-session-result";
		const WORKSPACE_CONTEXT_REQUEST_TYPE = "connector-hub:workspace-context-request";
		const WORKSPACE_CONTEXT_RESULT_TYPE = "connector-hub:workspace-context";
		const THEME_FONTS_REQUEST_TYPE = "connector-hub:theme-fonts-request";
		const THEME_FONTS_RESULT_TYPE = "connector-hub:theme-fonts";
		/**
		 * 读取宿主写入 body 的字体设置。
		 *
		 * DSH 的 ui-theme 把用户在「设置 → 字体」里选的字族与内容字号写在
		 * `document.body.style` 的 CSS 自定义属性上。面板是独立 iframe，CSS 变量
		 * 不会跨文档继承，因此显式取值后通过 postMessage 传给面板。
		 * 变量缺失（用户没改过）时返回空串，面板回退到自己的系统字体栈。
		 *
		 * @returns {{ text: string, code: string, contentSize: string }}
		 */
		function readHostFonts() {
			let style;
			try {
				style = document.body.style;
			} catch {
				return { text: "", code: "", contentSize: "" };
			}
			const read = (name) => {
				try {
					return style.getPropertyValue(name).trim();
				} catch {
					return "";
				}
			};
			// 字族取值优先级（从「最终生效」往回退）：
			// 1) `--dsw-font-family`：DSH 的**基准字族令牌**，组合式字体全部读它。
			//    壁纸引擎的「全局字体」、以及其他接管排版的插件都写这里，
			//    所以它才是用户实际看到的字体（楷体就走这条）。
			// 2) `--dsh-font-family-text`：DSH 官方「设置 → 字体」的字族。
			// 3) 都为空 → 面板用自带系统栈。
			// `--dsw-font-family` 的值是组合式（`var(--dsh-font-family-text, …), …`），
			// style.getPropertyValue 拿到的是未解析的原文，直接塞给子文档会变成无效值。
			// 用 getComputedStyle 拿**解析后**的真实字体列表；再退回到可解析的原始令牌。
			let base = "";
			try {
				base = String(getComputedStyle(document.body).fontFamily || "").trim().slice(0, 400);
			} catch { /* 计算样式不可用时退回下面的令牌 */ }
			const text = read("--dsh-font-family-text");
			return {
				text: base || text,
				code: read("--dsh-font-family-code") || read("--dsh-font-family-code-default"),
				contentSize: read("--dsh-content-font-size"),
				codeSize: read("--dsh-code-font-size")
			};
		}
		/** 两套字体读数是否一致；用于跳过无意义的重复推送。 */
		function sameHostFonts(left, right) {
			return left?.text === right?.text && left?.code === right?.code
				&& left?.contentSize === right?.contentSize && left?.codeSize === right?.codeSize;
		}

		const VERSION_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1e3;
		const VERSION_CHECK_RETRY_MS = 5 * 60 * 1e3;
		const NPM_PACKAGE_URL = "https://www.npmjs.com/package/dsh-connector-hub";
		const PLUGIN_PACKAGE_NAME = "dsh-connector-hub";
		const CONNECTOR_SETTINGS_NAMESPACE = "connector-hub";
		const SHOW_SIDEBAR_ENTRY_FIELD = "showSidebarEntry";
		const CONNECTOR_MODAL_Z_INDEX = 1100;

		/**
		 * DSH 0.1.x 的 sidebar.footer.action 兼容入口样式。新版宿主使用
		 * sidebar.panellist 原生行，不会安装本段 CSS。兼容适配器只样式化
		 * 本插件节点，不改写公共槽位或其它插件子项（#124）。
		 */
		const SIDEBAR_STYLE_ID = "dsh-connector-hub-sidebar";
		const sidebarCss = `
.mcpConnectorLauncher {
	flex: none;
	display: flex;
	align-items: center;
	box-sizing: border-box;
	width: 100%;
	height: 42px;
	margin: 4px 0;
	padding: 0 var(--dsh-sidebar-inline-padding, 12px);
	gap: 8px;
	justify-content: flex-start;
	overflow: hidden;
	border: 0;
	border-radius: 12px;
	background: transparent;
	color: inherit;
	font: inherit;
	white-space: nowrap;
	cursor: pointer;
}

.mcpConnectorLauncher[data-placement="footer"] {
	flex: 1 1 0;
	width: auto;
	min-width: 0;
	max-width: 100%;
}

.mcpConnectorLauncher:hover {
	background: rgba(127, 127, 127, 0.12);
	outline: none;
}

.mcpConnectorLauncher:focus-visible {
	background: rgba(127, 127, 127, 0.12);
	outline: 2px solid currentColor;
	outline-offset: -2px;
}

.mcpConnectorLauncherIcon {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	flex: 0 0 20px;
	width: 20px;
	height: 20px;
	color: inherit;
}

.mcpConnectorLauncherIcon > svg {
	display: block;
	width: 18px;
	height: 18px;
}

.mcpConnectorLauncherLabel {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
}

.mcpConnectorLauncher[data-wide="false"] {
	flex: none;
	width: 36px;
	height: 36px;
	margin: 8px 0 10px;
	padding: 0;
	justify-content: center;
	border-radius: 50%;
}

.mcpConnectorTopMount {
	flex: none;
	min-width: 0;
	width: 100%;
}

.mcpConnectorTopEntry {
	box-sizing: border-box;
	width: 100%;
	padding-right: var(--dsh-sidebar-inline-padding, 12px);
}

.mcpConnectorTopEntry .mcpConnectorLauncher {
	width: 100%;
	margin: 0 0 8px;
}

.mcpConnectorTopEntry[data-wide="false"] {
	width: 36px;
	padding-right: 0;
}

.mcpConnectorTopEntry[data-wide="false"] .mcpConnectorLauncher {
	margin: 0 0 8px;
}
`;
		const OVERLAY_STYLE_ID = "dsh-connector-hub-overlay";
		const overlayCss = `

.mcpConnectorMarketPanel { background: #ffffff; color: #111827; }
.mcpConnectorMarketHeader { border-color: #e5e7eb; }
.mcpConnectorMarketTitle { color: #111827; }
.mcpConnectorMarketIcon {
	display: inline-flex;
	align-items: center;
	color: inherit;
}
.mcpConnectorMarketIcon > svg {
	display: block;
	width: 18px;
	height: 18px;
}
.mcpConnectorMarketClose { color: #6b7280; }
.mcpConnectorMarketClose:hover,
.mcpConnectorMarketClose:focus-visible {
	background: #f3f4f6 !important;
	color: #111827;
	outline: 2px solid #6366f1;
	outline-offset: 1px;
}

@media (prefers-color-scheme: dark) {
	.mcpConnectorMarketPanel { background: #1b1e25; color: #f3f4f6; }
	.mcpConnectorMarketHeader { border-color: #30343d; }
	.mcpConnectorMarketTitle { color: #f3f4f6; }
	.mcpConnectorMarketClose { color: #c4c8d0; }
	.mcpConnectorMarketClose:hover,
	.mcpConnectorMarketClose:focus-visible { background: #30343d !important; color: #ffffff; }
}
`;
		const SETTINGS_STYLE_ID = "dsh-connector-hub-settings";
		const settingsCss = `
.mcpConnectorSettingsCard {
	border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.28));
	background: var(--dsw-alias-bg-layer-3, transparent);
	border-radius: 12px;
	list-style: none;
}
.mcpConnectorSettingsCard[data-open="true"] {
	background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.06));
	border-color: var(--dsw-alias-label-dimmed, rgba(127, 127, 127, 0.5));
}
.mcpConnectorSettingsHeader {
	appearance: none;
	display: flex;
	align-items: center;
	gap: 12px;
	width: 100%;
	padding: 14px 16px;
	border: 0;
	border-radius: 12px;
	color: inherit;
	background: transparent;
	font: inherit;
	text-align: left;
	cursor: pointer;
}
.mcpConnectorSettingsHeader:focus-visible,
.mcpConnectorSettingsButton:focus-visible,
.mcpConnectorSettingsSwitch:focus-visible {
	outline: 2px solid var(--dsw-alias-brand-primary, currentColor);
	outline-offset: 2px;
}
.mcpConnectorSettingsHeadText {
	display: flex;
	flex: 1;
	flex-direction: column;
	gap: 4px;
	min-width: 0;
}
.mcpConnectorSettingsName {
	color: var(--dsw-alias-label-primary, inherit);
	font-size: 15px;
	font-weight: 600;
	line-height: 1.4;
}
.mcpConnectorSettingsDescription,
.mcpConnectorSettingsHint,
.mcpConnectorSettingsState {
	color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.9));
	font-size: 13px;
	line-height: 1.5;
}
.mcpConnectorSettingsChevron {
	flex: none;
	color: var(--dsw-alias-label-tertiary, currentColor);
	font-size: 16px;
	transition: transform 0.16s;
}
.mcpConnectorSettingsCard[data-open="true"] .mcpConnectorSettingsChevron {
	transform: rotate(180deg);
}
.mcpConnectorSettingsBody {
	margin: 0 16px;
	padding: 14px 0 10px;
	border-top: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.28));
}
.mcpConnectorSettingsRow {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto;
	align-items: center;
	gap: 18px;
}
.mcpConnectorSettingsLabel {
	display: block;
	color: var(--dsw-alias-label-primary, inherit);
	font-size: 14px;
	font-weight: 600;
}
.mcpConnectorSettingsHint {
	display: block;
	margin-top: 5px;
}
.mcpConnectorSettingsSwitch {
	position: relative;
	appearance: none;
	width: 42px;
	height: 24px;
	margin: 0;
	border: 0;
	border-radius: 999px;
	background: var(--dsw-alias-fill-secondary, rgba(127, 127, 127, 0.35));
	cursor: pointer;
	transition: background 0.16s;
}
.mcpConnectorSettingsSwitch::after {
	position: absolute;
	top: 3px;
	left: 3px;
	width: 18px;
	height: 18px;
	border-radius: 50%;
	background: #ffffff;
	box-shadow: 0 1px 3px rgba(0, 0, 0, 0.28);
	content: "";
	transition: transform 0.16s;
}
.mcpConnectorSettingsSwitch:checked {
	background: var(--dsw-alias-state-success, #16a34a);
}
.mcpConnectorSettingsSwitch:checked::after {
	transform: translateX(18px);
}
.mcpConnectorSettingsSwitch:disabled {
	cursor: default;
	opacity: 0.55;
}
.mcpConnectorSettingsFooter {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 8px;
	margin-top: 14px;
	padding-top: 12px;
	border-top: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.28));
}
.mcpConnectorSettingsState {
	flex: 1 1 210px;
	margin: 0;
}
.mcpConnectorSettingsState[data-tone="error"] {
	color: var(--dsw-alias-label-error, #b91c1c);
}
.mcpConnectorSettingsButton {
	appearance: none;
	padding: 6px 12px;
	border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.28));
	border-radius: 8px;
	color: var(--dsw-alias-label-secondary, inherit);
	background: transparent;
	font: inherit;
	font-size: 13px;
	cursor: pointer;
}
.mcpConnectorSettingsButton[data-primary="true"] {
	border-color: transparent;
	color: var(--dsw-alias-bg-layer-3, #ffffff);
	background: var(--dsw-alias-label-primary, #111827);
}
.mcpConnectorSettingsButton:disabled {
	cursor: default;
	opacity: 0.45;
}
@media (max-width: 520px) {
	.mcpConnectorSettingsRow { grid-template-columns: 1fr; }
	.mcpConnectorSettingsFooter .mcpConnectorSettingsButton { flex: 1 1 140px; }
}
`;
		const SIDEBAR_WORKSPACES_SELECTOR = '[data-slot="sidebar.workspaces"]';
		const TOP_MOUNT_SELECTOR = '[data-connector-hub-top-mount="true"]';

		function installStyles(id, css) {
			if (document.querySelector(`style[data-plugin="${id}"]`) !== null) return () => {};
			const style = document.createElement("style");
			style.dataset.plugin = id;
			style.textContent = css;
			document.head.append(style);
			return () => { style.remove(); };
		}

		function installSidebarStyles() {
			return installStyles(SIDEBAR_STYLE_ID, sidebarCss);
		}

		function installOverlayStyles() {
			return installStyles(OVERLAY_STYLE_ID, overlayCss);
		}

		function installSettingsStyles() {
			return installStyles(SETTINGS_STYLE_ID, settingsCss);
		}

		/**
		 * DSH rc.7 没有公开的「新会话与工作区之间」插槽。插件仍注册在公开的
		 * footer list slot 中保证生命周期与降级可用，再把实际按钮 Portal 到
		 * sidebar.workspaces 前。只依赖稳定的 data-slot，不依赖构建生成的 CSS 类名。
		 */
		function ensureTopLauncherMount() {
			const workspaceSlot = document.querySelector(SIDEBAR_WORKSPACES_SELECTOR);
			const parent = workspaceSlot?.parentElement;
			if (workspaceSlot === null || parent === null || parent === void 0) return null;
			let mount = parent.querySelector(TOP_MOUNT_SELECTOR);
			if (mount === null) {
				mount = document.createElement("div");
				mount.dataset.mcpConnectorTopMount = "true";
				mount.className = "mcpConnectorTopMount";
			}
			if (mount.nextSibling !== workspaceSlot) parent.insertBefore(mount, workspaceSlot);
			return mount;
		}















		/**
		 * 创建符合 DSH Slot Store contract 的本地状态句柄。
		 * 只依赖 getSnapshot/subscribe/actions，避免不同 Host 版本的 Store
		 * 包名或客户端模块到达顺序让整个 Desktop 进入 Safe Mode。
		 */
		function createMarketViewStore() {
			let sidebarVisible = true;
			const liveActions = new Set();
			const visibilityListeners = new Set();
			const spec = {
				init: () => ({ open: false, detailOpen: false, sidebarVisible }),
				actions: {
					open: (draft) => { draft.open = true; },
					close: (draft) => { draft.open = false; draft.detailOpen = false; },
					detailOpened: (draft) => { draft.detailOpen = true; },
					detailClosed: (draft) => { draft.detailOpen = false; },
					setSidebarVisible: (draft, visible) => { draft.sidebarVisible = visible !== false; }
				}
			};
			return {
				spec,
				getSidebarVisible() {
					return sidebarVisible;
				},
				subscribeSidebarVisible(listener) {
					visibilityListeners.add(listener);
					return () => { visibilityListeners.delete(listener); };
				},
				syncSidebarVisible(visible) {
					const next = visible !== false;
					if (sidebarVisible === next) return;
					sidebarVisible = next;
					for (const actions of liveActions) actions.setSidebarVisible(sidebarVisible);
					for (const listener of visibilityListeners) listener(sidebarVisible);
				},
				create() {
					let state = spec.init();
					const listeners = new Set();
					const actions = {};
					for (const [name, mutate] of Object.entries(spec.actions)) {
						actions[name] = (...params) => {
							const draft = { ...state };
							mutate(draft, ...params);
							state = draft;
							for (const listener of listeners) listener();
						};
					}
					liveActions.add(actions);
					return {
						actions,
						getSnapshot: () => state,
						subscribe(listener) {
							listeners.add(listener);
							return () => { listeners.delete(listener); };
						},
						clearPersisted() {
							liveActions.delete(actions);
							listeners.clear();
						}
					};
				}
			};
		}

		function resolveSidebarVisible(snapshot) {
			return snapshot?.status === "ready"
				? snapshot.value?.[SHOW_SIDEBAR_ENTRY_FIELD] !== false
				: true;
		}

		/** 设置卡片文案：中英文都来自同一份 msgid 词典。 */
		function connectorSettingsCopy() {
			return {
				title: t("连接器"),
				description: t("控制侧边栏入口和快捷打开方式。"),
				show: t("在侧边栏显示 连接器"),
				hint: t("关闭后只隐藏入口，不影响已连接的 MCP Server 和工具。"),
				visible: t("侧边栏入口当前显示。"),
				hidden: t("入口已隐藏，仍可从这里打开 连接器。"),
				readOnly: t("当前设置页只读。"),
				saving: t("正在保存…"),
				failed: t("设置未保存，请重试。"),
				reset: t("恢复默认"),
				open: t("打开 连接器"),
				expand: t("展开 连接器设置"),
				collapse: t("收起 连接器设置")
			};
		}

		function ConnectorSettingsCard(props) {
			const { settingsScope, actions } = props;
			const copy = connectorSettingsCopy();
			const snapshot = (0, react.useSyncExternalStore)(
				(listener) => settingsScope.subscribe(listener),
				() => settingsScope.getSnapshot()
			);
			const [open, setOpen] = (0, react.useState)(false);
			const [saving, setSaving] = (0, react.useState)(false);
			const [failed, setFailed] = (0, react.useState)(false);
			if (snapshot.status !== "ready") return null;
			const visible = resolveSidebarVisible(snapshot);
			const writable = snapshot.writable === true;
			const overridden = snapshot.user !== null
				&& typeof snapshot.user === "object"
				&& Object.prototype.hasOwnProperty.call(snapshot.user, SHOW_SIDEBAR_ENTRY_FIELD);

			const save = async (next) => {
				setSaving(true);
				setFailed(false);
				try {
					await settingsScope.set(SHOW_SIDEBAR_ENTRY_FIELD, next);
					const confirmed = settingsScope.getSnapshot();
					setFailed(confirmed.status !== "ready" || resolveSidebarVisible(confirmed) !== next);
				} catch (error) {
					console.error("[connector-hub] sidebar setting update failed:", error);
					setFailed(true);
				} finally {
					setSaving(false);
				}
			};

			const reset = async () => {
				setSaving(true);
				setFailed(false);
				try {
					await settingsScope.unset(SHOW_SIDEBAR_ENTRY_FIELD);
					const confirmed = settingsScope.getSnapshot();
					const stillOverridden = confirmed.user !== null
						&& typeof confirmed.user === "object"
						&& Object.prototype.hasOwnProperty.call(confirmed.user, SHOW_SIDEBAR_ENTRY_FIELD);
					setFailed(confirmed.status !== "ready" || stillOverridden);
				} catch (error) {
					console.error("[connector-hub] sidebar setting reset failed:", error);
					setFailed(true);
				} finally {
					setSaving(false);
				}
			};

			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: "mcpConnectorSettingsCard",
				"data-open": open,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						className: "mcpConnectorSettingsHeader",
						"aria-expanded": open,
						"aria-label": open ? copy.collapse : copy.expand,
						onClick: () => { setOpen(!open); },
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "mcpConnectorSettingsHeadText",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "mcpConnectorSettingsName", children: copy.title }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "mcpConnectorSettingsDescription", children: copy.description })
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "mcpConnectorSettingsChevron", "aria-hidden": true, children: "⌄" })
						]
					}),
					open ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "mcpConnectorSettingsBody",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "mcpConnectorSettingsRow",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										htmlFor: "connector-hub-show-sidebar-entry",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "mcpConnectorSettingsLabel", children: copy.show }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "mcpConnectorSettingsHint", children: copy.hint })
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										id: "connector-hub-show-sidebar-entry",
										className: "mcpConnectorSettingsSwitch",
										type: "checkbox",
										role: "switch",
										"aria-checked": visible,
										checked: visible,
										disabled: !writable || saving,
										onChange: (event) => { void save(event.target.checked); }
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "mcpConnectorSettingsFooter",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "mcpConnectorSettingsState",
										"data-tone": failed ? "error" : "normal",
										role: failed ? "alert" : "status",
										children: failed ? copy.failed : saving ? copy.saving : !writable ? copy.readOnly : visible ? copy.visible : copy.hidden
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "mcpConnectorSettingsButton",
										disabled: !writable || saving || !overridden,
										onClick: () => { void reset(); },
										children: copy.reset
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "mcpConnectorSettingsButton",
										"data-primary": true,
										"aria-haspopup": "dialog",
										onClick: () => { actions.open(); },
										children: copy.open
									})
								]
							})
						]
					}) : null
				]
			});
		}

		function ConnectorSettingsSection(props) {
			return (0, react_jsx_runtime.jsx)("ul", {
				style: { listStyle: "none", margin: 0, padding: 0 },
				children: (0, react_jsx_runtime.jsx)(ConnectorSettingsCard, props)
			});
		}

		function installClientSettings(ctx, marketView) {
			if (typeof ctx.inject !== "function") return;
			ctx.inject(["settingsScope"], (settingsCtx) => {
				if (typeof settingsCtx?.settingsScope?.bind !== "function") return;
				const settingsScope = settingsCtx.settingsScope.bind({
					namespace: CONNECTOR_SETTINGS_NAMESPACE,
					decode(value) {
						if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
						return typeof value[SHOW_SIDEBAR_ENTRY_FIELD] === "boolean"
							? { [SHOW_SIDEBAR_ENTRY_FIELD]: value[SHOW_SIDEBAR_ENTRY_FIELD] }
							: void 0;
					}
				});
				if (typeof settingsScope?.getSnapshot !== "function"
					|| typeof settingsScope?.subscribe !== "function") return;
				settingsCtx.effect(() => {
					const sync = () => { marketView.syncSidebarVisible(resolveSidebarVisible(settingsScope.getSnapshot())); };
					sync();
					const unsubscribe = settingsScope.subscribe(sync);
					return () => {
						unsubscribe();
						marketView.syncSidebarVisible(true);
					};
				}, "connector-hub: sidebar visibility setting");
				settingsCtx.effect(() => installSettingsStyles(), "connector-hub: settings styles");
				// Modern hosts may omit the Plugins page entirely. Contribute our own
				// section without depending on settings.plugin.item or widening tools.
				settingsCtx.slots.inject("settings.section", () => settingsCtx.slots.register({
					name: "settings.section",
					id: CONNECTOR_SETTINGS_NAMESPACE,
					order: 80,
					label: t("连接器"),
					store: marketView,
					inject: () => ({ settingsScope })
				}, ConnectorSettingsSection));
				settingsCtx.slots.inject("settings.plugin.item", () => settingsCtx.slots.register({
					name: "settings.plugin.item",
					key: CONNECTOR_SETTINGS_NAMESPACE,
					store: marketView,
					inject: () => ({ settingsScope })
				}, ConnectorSettingsCard));
			});
		}

		/**
		 * 用 DSH 自身的工作区/会话/输入机把示例 Prompt 带入新会话。
		 * connectWorkspace 与 DSH 的「新会话」按钮同源：优先复用当前工作区的
		 * 空白会话，没有时创建一个；返回时 binding 已就绪，可在导航前写入草稿。
		 */
		function currentWorkspaceContext(ctx) {
			const workspace = ctx.workspaces.list.getSnapshot();
			const current = ctx.sessions.list.getSnapshot().current;
			const selected = current === void 0
				? void 0
				: workspace.items.find((item) => item.sessionIds.includes(current));
			const targetWorkspaceId = selected?.workspaceId ?? workspace.recentWorkspaceId;
			const target = workspace.items.find((item) => item.workspaceId === targetWorkspaceId);
			return targetWorkspaceId === void 0 ? null : {
				workspaceId: targetWorkspaceId,
				title: target?.title ?? String(targetWorkspaceId)
			};
		}

		function availableWorkspaceContexts(ctx) {
			const items = ctx.workspaces.list.getSnapshot()?.items;
			if (!Array.isArray(items)) return [];
			const workspaces = new Map();
			for (const item of items) {
				if (typeof item?.workspaceId !== "string" || item.workspaceId === "") continue;
				workspaces.set(item.workspaceId, {
					workspaceId: item.workspaceId,
					title: item.title ?? String(item.workspaceId)
				});
			}
			return [...workspaces.values()];
		}

		async function startPromptSession(ctx, promptText) {
			if (typeof promptText !== "string" || promptText.trim() === "") {
				throw new Error(t("Prompt 不能为空"));
			}
			const targetWorkspaceId = currentWorkspaceContext(ctx)?.workspaceId;
			if (targetWorkspaceId === void 0) {
				throw new Error(t("请先选择一个工作空间，再使用示例 Prompt"));
			}
			// DSH 0.1.2 将跨 Controller 的导航能力从 workspaces 移到
			// uiWorkspace；0.1.1 Desktop 仍暴露旧方法。优先使用当前公开能力，
			// 再兼容旧版，最后以 sessions.create 保证未来移除桥接方法时仍能
			// 在目标 Workspace 创建原生会话。
			const uiWorkspace = typeof ctx.get === "function"
				? ctx.get("uiWorkspace")
				: ctx.uiWorkspace;
			let sessionId;
			if (typeof uiWorkspace?.connectWorkspace === "function") {
				sessionId = await uiWorkspace.connectWorkspace(targetWorkspaceId);
			} else if (typeof ctx.workspaces?.connectWorkspace === "function") {
				sessionId = await ctx.workspaces.connectWorkspace(targetWorkspaceId);
			} else if (typeof ctx.sessions?.create === "function") {
				sessionId = await ctx.sessions.create({ workspaceId: targetWorkspaceId });
			} else {
				throw new Error(t("当前 DSH 版本没有可用的工作区会话创建能力，请升级 DSH 后重试"));
			}
			const conversation = ctx.get("conversation");
			if (conversation === void 0) {
				throw new Error(t("DSH 对话服务尚未就绪，请稍后重试"));
			}
			conversation.input.shell(sessionId).setDraft(promptText);
			ctx.sessions.open(sessionId);
			return sessionId;
		}

		/** 市场主体：原生 main 面板与设置页快捷弹框共用。 */
		function MarketOverlay(props) {
			const {
				wide,
				useStore,
				actions,
				presentation = "modal",
				closePanel = null,
				startPromptSession: launchPromptSession,
				workspaceContext = () => null,
				workspaceOptions = () => [],
				iframeLocale = DEFAULT_LOCALE
			} = props;
			const modalOpen = useStore((state) => state.open);
			const open = presentation === "panel" || modalOpen;
			const closeView = () => {
				if (presentation === "panel") closePanel?.();
				else actions.close();
			};
			const detailOpen = useStore((state) => state.detailOpen);
			const frameRef = (0, react.useRef)(null);
			const closeRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				const sendWorkspaceContext = () => {
					frameRef.current?.contentWindow?.postMessage({
						type: WORKSPACE_CONTEXT_RESULT_TYPE,
						workspace: workspaceContext(),
						workspaces: workspaceOptions()
					}, window.location.origin);
				};
				const sendHostFonts = () => {
					frameRef.current?.contentWindow?.postMessage({
						type: THEME_FONTS_RESULT_TYPE,
						fonts: readHostFonts()
					}, window.location.origin);
				};
				const onMessage = (event) => {
					if (event.origin !== window.location.origin) return;
					if (event.source !== frameRef.current?.contentWindow) return;
					if (event.data?.type === THEME_FONTS_REQUEST_TYPE) {
						sendHostFonts();
						return;
					}
					if (event.data?.type === "connector-hub:detail-state") {
						if (event.data.open === true) actions.detailOpened();
						else actions.detailClosed();
						return;
					}
					if (event.data?.type === WORKSPACE_CONTEXT_REQUEST_TYPE) {
						sendWorkspaceContext();
						return;
					}
					if (event.data?.type !== PROMPT_REQUEST_TYPE) return;
					const requestId = typeof event.data.requestId === "string" ? event.data.requestId : "";
					const prompt = event.data.prompt;
					const reply = (ok, message) => {
						frameRef.current?.contentWindow?.postMessage({
							type: PROMPT_RESULT_TYPE,
							requestId,
							ok,
							message
						}, window.location.origin);
					};
					if (requestId === "" || typeof prompt !== "string") {
						reply(false, t("无效的 Prompt 请求"));
						return;
					}
					Promise.resolve(launchPromptSession(prompt)).then(() => {
						reply(true, t("已带入新会话"));
						window.requestAnimationFrame(closeView);
					}, (error) => {
						const message = error instanceof Error ? error.message : String(error);
						console.error("[connector-hub] start prompt session failed:", error);
						reply(false, message);
					});
				};
				window.addEventListener("message", onMessage);

				// 字体实时同步：DSH 改字号/字族时重写 body.style，属性变化即推送。
				// 监听属性而非订阅 theme/change，避免依赖宿主内部事件契约。
				let lastFonts = readHostFonts();
				let fontObserver;
				try {
					fontObserver = new MutationObserver(() => {
						const next = readHostFonts();
						if (sameHostFonts(next, lastFonts)) return;
						lastFonts = next;
						sendHostFonts();
					});
					fontObserver.observe(document.body, { attributes: true, attributeFilter: ["style"] });
				} catch (error) {
					console.warn("[connector-hub] font observer unavailable:", error);
				}

				return () => {
					window.removeEventListener("message", onMessage);
					fontObserver?.disconnect();
				};
			}, [actions, closePanel, launchPromptSession, presentation, workspaceContext]);
			(0, react.useEffect)(() => {
				if (!open || presentation === "panel") return void 0;
				const opener = document.activeElement;
				closeRef.current?.focus?.();
				const onKeyDown = (event) => {
					if (event.key !== "Escape") return;
					event.preventDefault();
					event.stopPropagation();
					closeView();
				};
				// Capture at window before the underlying Settings dialog receives
				// Escape on document; only the topmost connector dialog should close.
				window.addEventListener("keydown", onKeyDown, true);
				return () => {
					window.removeEventListener("keydown", onKeyDown, true);
					if (opener?.isConnected !== false) opener?.focus?.();
				};
			}, [open, actions, closePanel, presentation]);
			if (!open) return null;
			// `iframeLocale` 可以是取值函数：语言服务晚于 apply() 就绪时，
			// 这里每次渲染都能读到最新语言，而不是注册时的快照。
			const src = marketIframeSrc(typeof iframeLocale === "function" ? iframeLocale() : iframeLocale);
			const titleId = presentation === "panel"
				? "connector-hub-native-title"
				: "connector-hub-modal-title";
			const marketPanel = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "mcpConnectorMarketPanel",
						role: presentation === "panel" ? "region" : "dialog",
						"aria-modal": presentation === "panel" ? void 0 : true,
						"aria-labelledby": titleId,
						style: {
							borderRadius: presentation === "panel" ? 0 : 16,
							width: presentation === "panel" ? "100%" : "min(800px, 90%)",
							height: presentation === "panel" ? "100%" : "min(800px, 85%)",
							display: "flex",
							flexDirection: "column",
							boxShadow: presentation === "panel" ? "none" : "0 20px 60px rgba(0,0,0,0.15)",
							overflow: "hidden"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "mcpConnectorMarketHeader",
								style: {
									display: "flex",
									alignItems: "center",
									justifyContent: "space-between",
									padding: "20px 24px",
									borderBottom: "1px solid",
									flexShrink: 0,
									filter: detailOpen ? "brightness(0.5)" : "none",
									pointerEvents: detailOpen ? "none" : "auto",
									transition: "filter 0.2s ease"
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", minWidth: 0, flex: 1 },
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "mcpConnectorMarketIcon",
												"aria-hidden": true,
												children: (0, react_jsx_runtime.jsxs)("svg", {
													viewBox: "0 0 16 16",
													fill: "none",
													"aria-hidden": "true",
													children: [
(0, react_jsx_runtime.jsx)("rect", { x: 2.5, y: 2.5, width: 3, height: 3, rx: 0.8, fill: "currentColor" }),
														(0, react_jsx_runtime.jsx)("rect", { x: 6.5, y: 2.5, width: 3, height: 3, rx: 0.8, fill: "currentColor", opacity: 0.45 }),
														(0, react_jsx_runtime.jsx)("rect", { x: 10.5, y: 2.5, width: 3, height: 3, rx: 0.8, fill: "currentColor", opacity: 0.45 }),
														(0, react_jsx_runtime.jsx)("rect", { x: 2.5, y: 6.5, width: 3, height: 3, rx: 0.8, fill: "currentColor", opacity: 0.45 }),
														(0, react_jsx_runtime.jsx)("rect", { x: 6.5, y: 6.5, width: 3, height: 3, rx: 0.8, fill: "currentColor", opacity: 0.45 }),
														(0, react_jsx_runtime.jsx)("rect", { x: 10.5, y: 6.5, width: 3, height: 3, rx: 0.8, fill: "currentColor", opacity: 0.45 }),
														(0, react_jsx_runtime.jsx)("rect", { x: 2.5, y: 10.5, width: 3, height: 3, rx: 0.8, fill: "currentColor", opacity: 0.45 }),
														(0, react_jsx_runtime.jsx)("rect", { x: 6.5, y: 10.5, width: 3, height: 3, rx: 0.8, fill: "currentColor", opacity: 0.45 }),
														(0, react_jsx_runtime.jsx)("rect", { x: 10.5, y: 10.5, width: 3, height: 3, rx: 0.8, fill: "currentColor", opacity: 0.45 })
													]
												})
											}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { id: titleId, className: "mcpConnectorMarketTitle", style: { fontSize: 18, fontWeight: 600 }, children: t("连接器") }),
											]
										}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										ref: closeRef,
										className: "mcpConnectorMarketClose",
										type: "button",
										"aria-label": presentation === "panel" ? t("返回会话") : t("关闭 连接器"),
										onClick: closeView,
										style: {
											background: "transparent",
											border: "none",
											fontSize: 22,
											cursor: "pointer",
											padding: "4px 8px",
											borderRadius: 6,
											lineHeight: 1
										},
										children: "\u00D7"
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("iframe", {
								ref: frameRef,
								src,
								onLoad: () => {
									const frame = frameRef.current?.contentWindow;
									if (!frame) return;
									frame.postMessage({ type: WORKSPACE_CONTEXT_RESULT_TYPE, workspace: workspaceContext() }, window.location.origin);
									// 面板首帧就带上宿主字体，避免先按默认字体渲染再跳变。
									frame.postMessage({ type: THEME_FONTS_RESULT_TYPE, fonts: readHostFonts() }, window.location.origin);
								},
								title: t("连接器"),
								style: {
									flex: 1,
									width: "100%",
									border: "none",
									background: "transparent",
									colorScheme: "light dark"
								}
							})
						]
					});
			if (presentation === "panel") return marketPanel;
			const modal = /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					position: "fixed",
					inset: 0,
					background: "rgba(0,0,0,0.4)",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					zIndex: CONNECTOR_MODAL_Z_INDEX
				},
				onClick: (event) => { if (event.target === event.currentTarget) closeView(); },
				children: marketPanel
			});
			// shell.overlay lives inside a z-index:20 stacking context, while DSH
			// Settings is a root-level z-index:1000 modal. Portal to body so the
			// quick-open action can reliably place this dialog above Settings.
			if (document.body !== null && document.body !== void 0
				&& typeof react_dom.createPortal === "function") {
				return react_dom.createPortal(modal, document.body);
			}
			return modal;
		}

		/** DSH 0.1.x 兼容入口：仅在原生面板席位不完整时挂载。 */
		function LegacySidebarEntry(props) {
			const { wide, useStore, actions } = props;
			const open = useStore((state) => state.open);
			const visible = useStore((state) => state.sidebarVisible !== false);
			const [topMount, setTopMount] = (0, react.useState)(null);
			(0, react.useEffect)(() => {
				if (!visible) {
					setTopMount(null);
					return void 0;
				}
				const removeStyles = installSidebarStyles();
				let disposed = false;
				const ownedMounts = new Set();
				const syncMount = () => {
					if (disposed) return;
					const mount = ensureTopLauncherMount();
					if (mount !== null) ownedMounts.add(mount);
					setTopMount((current) => current === mount ? current : mount);
				};
				syncMount();
				let observer = null;
				if (typeof window.MutationObserver === "function" && document.body !== null) {
					observer = new window.MutationObserver(syncMount);
					observer.observe(document.body, { childList: true, subtree: true });
				}
				return () => {
					disposed = true;
					observer?.disconnect();
					for (const mount of ownedMounts) mount.remove();
					removeStyles();
				};
			}, [visible]);
			if (!visible) return null;
			const launcher = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: "mcpConnectorLauncher",
				"data-wide": wide,
				"data-placement": topMount === null ? "footer" : "top",
				"aria-label": t("连接器"),
				"aria-haspopup": "dialog",
				"aria-expanded": open,
				onClick: () => { try { actions.open(); } catch (error) { console.error('[connector-hub] open failed:', error); } },
				children: [
					(0, react_jsx_runtime.jsx)("span", {
						className: "mcpConnectorLauncherIcon",
						"aria-hidden": true,
						children: (0, react_jsx_runtime.jsxs)("svg", {
							viewBox: "0 0 16 16",
							fill: "none",
							"aria-hidden": "true",
							children: [
(0, react_jsx_runtime.jsx)("rect", { x: 2.5, y: 2.5, width: 3, height: 3, rx: 0.8, fill: "currentColor" }),
								(0, react_jsx_runtime.jsx)("rect", { x: 6.5, y: 2.5, width: 3, height: 3, rx: 0.8, fill: "currentColor", opacity: 0.45 }),
								(0, react_jsx_runtime.jsx)("rect", { x: 10.5, y: 2.5, width: 3, height: 3, rx: 0.8, fill: "currentColor", opacity: 0.45 }),
								(0, react_jsx_runtime.jsx)("rect", { x: 2.5, y: 6.5, width: 3, height: 3, rx: 0.8, fill: "currentColor", opacity: 0.45 }),
								(0, react_jsx_runtime.jsx)("rect", { x: 6.5, y: 6.5, width: 3, height: 3, rx: 0.8, fill: "currentColor", opacity: 0.45 }),
								(0, react_jsx_runtime.jsx)("rect", { x: 10.5, y: 6.5, width: 3, height: 3, rx: 0.8, fill: "currentColor", opacity: 0.45 }),
								(0, react_jsx_runtime.jsx)("rect", { x: 2.5, y: 10.5, width: 3, height: 3, rx: 0.8, fill: "currentColor", opacity: 0.45 }),
								(0, react_jsx_runtime.jsx)("rect", { x: 6.5, y: 10.5, width: 3, height: 3, rx: 0.8, fill: "currentColor", opacity: 0.45 }),
								(0, react_jsx_runtime.jsx)("rect", { x: 10.5, y: 10.5, width: 3, height: 3, rx: 0.8, fill: "currentColor", opacity: 0.45 })
							]
						})
					}),
					wide ? (0, react_jsx_runtime.jsx)("span", { className: "mcpConnectorLauncherLabel", children: t("连接器") }) : null
				]
			});
			if (topMount === null || typeof react_dom.createPortal !== "function") return launcher;
			return react_dom.createPortal(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "mcpConnectorTopEntry",
				"data-wide": wide,
				children: launcher
			}), topMount);
		}

		/** 新版 DSH 会渲染整行按钮；插件只提供随 size/currentColor 变化的字形。 */
		function NativeSidebarIcon(props) {
			const size = Number.isFinite(props?.size) ? props.size : 16;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				viewBox: "0 0 16 16",
				width: size,
				height: size,
				fill: "none",
				stroke: "currentColor",
				"aria-hidden": "true",
				style: { display: "block" },
				children: [
					(0, react_jsx_runtime.jsx)("rect", { x: 2.5, y: 2.5, width: 3, height: 3, rx: 0.8, fill: "currentColor" }),
					(0, react_jsx_runtime.jsx)("rect", { x: 6.5, y: 2.5, width: 3, height: 3, rx: 0.8, fill: "currentColor", opacity: 0.45 }),
					(0, react_jsx_runtime.jsx)("rect", { x: 10.5, y: 2.5, width: 3, height: 3, rx: 0.8, fill: "currentColor", opacity: 0.45 }),
					(0, react_jsx_runtime.jsx)("rect", { x: 2.5, y: 6.5, width: 3, height: 3, rx: 0.8, fill: "currentColor", opacity: 0.45 }),
					(0, react_jsx_runtime.jsx)("rect", { x: 6.5, y: 6.5, width: 3, height: 3, rx: 0.8, fill: "currentColor", opacity: 0.45 }),
					(0, react_jsx_runtime.jsx)("rect", { x: 10.5, y: 6.5, width: 3, height: 3, rx: 0.8, fill: "currentColor", opacity: 0.45 }),
					(0, react_jsx_runtime.jsx)("rect", { x: 2.5, y: 10.5, width: 3, height: 3, rx: 0.8, fill: "currentColor", opacity: 0.45 }),
					(0, react_jsx_runtime.jsx)("rect", { x: 6.5, y: 10.5, width: 3, height: 3, rx: 0.8, fill: "currentColor", opacity: 0.45 }),
					(0, react_jsx_runtime.jsx)("rect", { x: 10.5, y: 10.5, width: 3, height: 3, rx: 0.8, fill: "currentColor", opacity: 0.45 })
				]
			});
		}

		/**
		 * 面板宿主与设置弹框共用的运行时 props（含面板语言）。
		 *
		 * 语言取自 `apply()` 解析并随可选 `locale` 注入更新的模块状态，而不是在
		 * 语言取自 `apply()` 解析并随可选注入更新的模块状态，不在这里重新读服务。
		 */
		function marketRuntimeProps(ctx) {
			return {
				startPromptSession: (promptText) => startPromptSession(ctx, promptText),
				workspaceContext: () => currentWorkspaceContext(ctx),
				workspaceOptions: () => availableWorkspaceContexts(ctx),
				iframeLocale: () => activeLocale
			};
		}

		/**
		 * 原生 main + sidebar.panellist 优先；两个席位未同时就绪时才启用
		 * DSH 0.1.x footer/Portal 兼容适配器。席位可以延迟声明，因此状态不依赖 DOM 探测。
		 */
		function installSidebarSlots(ctx, marketView) {
			let mainReady = false;
			let panelListReady = false;
			let footerReady = false;
			let nativeEntryDispose = null;
			let fallbackEntryDispose = null;

			const layout = () => typeof ctx.get === "function" ? ctx.get("layout") ?? ctx.layout : ctx.layout;
			const leaveNativePanel = () => {
				const controller = layout();
				try {
					if (controller?.panelInfo?.getSnapshot?.().activePanelId === "connector-hub") {
						controller.selectPanel(null);
					}
				} catch (error) {
					console.warn("[connector-hub] failed to leave native panel:", error);
				}
			};
			const disposeNativeEntry = () => {
				if (nativeEntryDispose === null) return;
				leaveNativePanel();
				nativeEntryDispose();
				nativeEntryDispose = null;
			};
			const disposeFallbackEntry = () => {
				if (fallbackEntryDispose === null) return;
				fallbackEntryDispose();
				fallbackEntryDispose = null;
			};
			const syncEntries = () => {
				const visible = marketView.getSidebarVisible();
				const nativeReady = mainReady && panelListReady;
				if (nativeReady) {
					disposeFallbackEntry();
					if (visible && nativeEntryDispose === null) {
						nativeEntryDispose = ctx.slots.register({
							name: "sidebar.panellist",
							id: "connector-hub",
							order: 40,
							// 传函数而不是字符串：槽位在**每次投影**时重新读取，侧边栏文案
							// 因此跟随当前语言，不必等重新注册（字符串会在注册时被固化，
							// 语言晚于 apply 就绪时永远停在旧文案）。
							label: () => t("连接器")
						}, NativeSidebarIcon);
					} else if (!visible) {
						disposeNativeEntry();
					}
					return;
				}
				disposeNativeEntry();
				if (footerReady && visible && fallbackEntryDispose === null) {
					fallbackEntryDispose = ctx.slots.register({
						name: "sidebar.footer.action",
						id: "connector-hub",
						order: 0,
						store: marketView
					}, LegacySidebarEntry);
				} else if (!visible) {
					disposeFallbackEntry();
				}
			};

			ctx.effect(() => {
				const unsubscribe = marketView.subscribeSidebarVisible(syncEntries);
				return () => {
					unsubscribe();
					disposeNativeEntry();
					disposeFallbackEntry();
				};
			}, "connector-hub: sidebar entry visibility");

			// main 必须先于 panellist 行就绪，否则宿主会拒绝选中缺页面的行。
			ctx.slots.inject("main", () => {
				const disposeMain = ctx.slots.register({
					name: "main",
					key: "connector-hub",
					store: marketView,
					inject: () => ({
						...marketRuntimeProps(ctx),
						presentation: "panel",
						closePanel: () => layout()?.selectPanel?.(null)
					})
				}, MarketOverlay);
				mainReady = true;
				syncEntries();
				return () => {
					leaveNativePanel();
					mainReady = false;
					syncEntries();
					disposeMain();
				};
			});

			ctx.slots.inject("sidebar.panellist", () => {
				panelListReady = true;
				syncEntries();
				return () => {
					panelListReady = false;
					syncEntries();
				};
			});

			ctx.slots.inject("sidebar.footer.action", () => {
				footerReady = true;
				syncEntries();
				return () => {
					footerReady = false;
					disposeFallbackEntry();
				};
			});
		}

		/**
		 * 语言服务通过**可选嵌套注入**接入：宿主没有 `locale` 服务时不注册回调，
		 * 插件照常加载并保持中文（§6.6）；服务晚于 apply 就绪时再切换。
		 */
		function installLocale(ctx) {
			if (typeof ctx.inject !== "function") return;
			try {
				ctx.inject(["locale"], (localeCtx) => {
					activeLocale = localeFromService(localeCtx) ?? DEFAULT_LOCALE;
				});
			} catch (error) {
				console.warn("[connector-hub] optional locale injection failed:", error);
			}
		}

		function apply(ctx) {
			console.log('[connector-hub] client apply() called');
			try {
				const marketView = createMarketViewStore();
				activeLocale = resolveLocaleId(ctx);
				installLocale(ctx);
				ctx.effect(() => installOverlayStyles(), "connector-hub: overlay styles");
				installClientSettings(ctx, marketView);

				// 弹框：注册到 shell.overlay（类似社区插件市场）
				ctx.slots.inject("shell.overlay", () => {
					console.log('[connector-hub] registering shell.overlay slot');
					return ctx.slots.register({
						name: "shell.overlay",
						id: "connector-hub",
						order: 100,
						store: marketView,
						inject: () => marketRuntimeProps(ctx)
					}, MarketOverlay);
				});

				installSidebarSlots(ctx, marketView);
				console.log('[connector-hub] client apply() completed');
			} catch (error) {
				console.error('[connector-hub] client apply() failed:', error);
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
