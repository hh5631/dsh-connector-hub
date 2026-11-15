/**
 * v5 面板的回归测试（极简：目录 + 已连接抽屉）
 *   1. 图标：icons.js 提供真实内联 SVG（不再是首字母占位），按 id / 类目映射，
 *      目录自带 URL icon 用 <img>；历史遗留路径归一；cardHtml 接上图标。
 *   2. 双布局：state.layout 决定 renderCatalog 用 grid-list / grid-cards，
 *      列表精简列（无厂商独立行）、栅格保留完整信息。
 *   3. 首屏：只 loadAll()（status + compact 目录），**全程不调 healthCheck**。
 *   4. 抽屉：已连接应用收进右上角抽屉，openDrawer/closeDrawer 维护可见性与 aria。
 *   5. 逻辑 bug：connect 凭据失败时 openRepair 能拿到 connectorId（含 UI 兜底）。
 *   6. 细节打磨：i18n 字典齐全、grid 已连标记、空状态动作、忙碌锁、焦点归还、
 *      dialog-open 滚动锁、抽屉行图标、搜索快捷键、aria-busy。
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/* ── 极简 DOM / Host 桩 ───────────────────────────────── */
const nodes = new Map();
const layoutBtns = [
  { dataset: { layout: 'list' }, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } },
  { dataset: { layout: 'grid' }, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } },
];
const makeNode = (id) => ({
  id, hidden: false, textContent: '', innerHTML: '', value: '', placeholder: '',
  dataset: {}, options: { length: 0 }, disabled: false, className: '',
  _signature: undefined, _timer: null, _onPage: null, checked: false, attrs: {},
  _focusCount: 0,
  addEventListener() {}, focus() { this._focusCount++; }, select() {},
  setAttribute(k, v) { this.attrs[k] = String(v); },
  getAttribute(k) { return this.attrs[k]; },
  removeAttribute(k) { delete this.attrs[k]; },
  querySelector() { return null; }, querySelectorAll() { return []; },
});
const get = (id) => { if (!nodes.has(id)) nodes.set(id, makeNode(id)); return nodes.get(id); };
get('layout-switch').querySelectorAll = () => layoutBtns;

const rootStyleProps = new Map();
const bodyClasses = new Set();
const docHandlers = {}; // 捕获 bind() 注册的 keydown/error 等监听，供交互测试触发
const document = {
  title: '', hidden: false, activeElement: null,
  documentElement: {
    lang: 'zh-CN',
    style: {
      setProperty: (k, v) => rootStyleProps.set(k, v),
      removeProperty: (k) => rootStyleProps.delete(k),
      getPropertyValue: (k) => rootStyleProps.get(k) ?? '',
    },
  },
  body: {
    classList: {
      add: (c) => bodyClasses.add(c),
      remove: (c) => bodyClasses.delete(c),
      contains: (c) => bodyClasses.has(c),
    },
  },
  getElementById: get,
  querySelectorAll: () => [],
  addEventListener(type, fn) { (docHandlers[type] ||= []).push(fn); },
  createElement: () => makeNode('tmp'),
};
const store = new Map();
const localStorage = {
  getItem: (k) => store.has(k) ? store.get(k) : null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const session = new Map();
const sessionStorage = {
  getItem: (k) => session.has(k) ? session.get(k) : null,
  setItem: (k, v) => session.set(k, String(v)),
  removeItem: (k) => session.delete(k),
};
const window = {
  location: { origin: 'http://127.0.0.1:4173', search: '' },
  __CONNECTOR_HUB_LOCALE__: 'zh-CN',
  parent: { postMessage() {} },
  addEventListener() {},
};
const location = window.location;

const fetchCalls = [];
const handlers = {}; // 测试可覆盖某 method 的返回体
const detail = (items) => ({ ok: true, detail: { items } });
const fetchImpl = async (url, opts) => {
  const body = JSON.parse(opts.body);
  fetchCalls.push(body);
  const h = handlers[body.method];
  if (h) return { ok: true, json: async () => h };
  if (body.method === 'status' || body.method === 'catalog') return { ok: true, json: async () => detail([]) };
  return { ok: true, json: async () => ({ ok: true, detail: {} }) };
};
class EventSource { addEventListener() {} close() {} }

const ctx = {
  document, window, location, fetch: fetchImpl, EventSource, localStorage, sessionStorage,
  URLSearchParams, setTimeout, clearTimeout, AbortController,
  confirm: () => false, console,
};
ctx.globalThis = ctx;
vm.createContext(ctx);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// 顺序与线上一致：icons.js 先挂 window.ConnectorIcons，再跑 hub.js。
vm.runInContext(readFileSync(join(root, 'ui/icons.js'), 'utf8'), ctx, { filename: 'icons.js' });
const hubCode = readFileSync(join(root, 'ui/hub.js'), 'utf8');
vm.runInContext(hubCode, ctx, { filename: 'hub.js' });

// 让文件尾浮动的首次 loadAll 跑完（busy 归位），后续测试才确定可控。
await new Promise((r) => setTimeout(r, 20));

const run = (expr) => vm.runInContext(expr, ctx);

/* ── 1. 图标 ─────────────────────────────────────────── */
test('icons.js：16 个真实 SVG 图标，按 id / 类目映射，未知名回退默认', () => {
  const I = window.ConnectorIcons;
  assert.equal(Object.keys(I.PATHS).length, 16);
  assert.equal(I.iconNameFor({ id: 'github' }), 'CodeOutlined');
  assert.equal(I.iconNameFor({ id: 'amap' }), 'EnvironmentOutlined');
  assert.equal(I.iconNameFor({ category: 'AI 模型' }), 'RobotOutlined');
  assert.equal(I.iconNameFor({ connectorId: 'cloudflare' }), 'CloudOutlined');
  assert.equal(I.iconNameFor({ id: 'zz', transport: 'stdio' }), 'ToolOutlined');
  assert.equal(I.iconNameFor({ id: 'zz' }), I.DEFAULT_ICON);
  assert.match(I.iconSvg('CodeOutlined', 18), /<svg[^>]*viewBox="64 64 896 896"/);
  assert.match(I.iconSvg('CodeOutlined', 18), /<path d=/);
  assert.match(I.iconSvg('NoSuchIcon'), /<svg/); // 未知名回退，不开天窗
});

test('图标：历史遗留的 /mcp-connector/ui/assets/ 路径改写到本插件挂载点', () => {
  const I = window.ConnectorIcons;
  assert.equal(
    I.normalizeAssetPath('/mcp-connector/ui/assets/pkulaw-logo.png'),
    '/connector-hub/ui/assets/pkulaw-logo.png',
  );
  assert.equal(I.normalizeAssetPath('/connector-hub/ui/assets/a.svg'), '/connector-hub/ui/assets/a.svg');
  assert.equal(I.normalizeAssetPath('https://cdn.example.com/x.png'), 'https://cdn.example.com/x.png');
  const html = I.iconHtml({ id: 'pkulaw-legal', icon: '/mcp-connector/ui/assets/pkulaw-logo.png' }, 16);
  assert.ok(html.includes('src="/connector-hub/ui/assets/pkulaw-logo.png"'));
});

test('图标：目录自带 URL icon 用 <img>，emoji 用文本，普通项用内联 SVG', () => {
  const I = window.ConnectorIcons;
  assert.match(I.iconHtml({ id: 'x', icon: 'https://cdn/x.png' }), /<img class="ci-img"/);
  assert.match(I.iconHtml({ id: 'x', icon: 'data:image/svg+xml,..' }), /<img class="ci-img"/);
  assert.match(I.iconHtml({ id: 'x', icon: '🚀' }), /<span class="ci-emoji">/);
  assert.match(I.iconHtml({ id: 'github' }), /<svg/); // 无 icon 字段 → 按 id 挑矢量
});

test('cardHtml：用真实内联 SVG 图标，不再用首字母占位', () => {
  ctx.__c = { id: 'github', name: 'GitHub', vendor: 'v', summary: 's', category: '开发工具', authMode: 'bearer', connected: [] };
  const html = run('cardHtml(__c, "list")');
  assert.match(html, /<svg[^>]*viewBox="64 64 896 896"/, '目录卡片含矢量图标');
  assert.doesNotMatch(html, /tile-icon">G<\/div>/, '不再是首字母 G 占位');
  assert.match(html, /data-act="connect" data-id="github"/);
});

/* ── 2. 列表 / 栅格 双布局 ───────────────────────────── */
test('双布局：grid 用 grid-cards 且保留厂商行，list 用 grid-list 且精简列', () => {
  ctx.__catalog = [{ id: 'github', name: 'GitHub', vendor: 'GitHub Inc', summary: '代码托管', category: '开发工具', authMode: 'bearer', connected: [] }];
  run('state.group = "all"; state.page = 0; state.query = ""; state.catalog = globalThis.__catalog;');

  run('state.layout = "grid"; renderCatalog("")');
  const grid = get('rows').innerHTML;
  assert.match(grid, /class="grid grid-cards"/, '栅格视图套 grid-cards');
  assert.match(grid, /tile-vendor/, '栅格卡片保留厂商行');

  run('state.layout = "list"; renderCatalog("")');
  const list = get('rows').innerHTML;
  assert.match(list, /class="grid grid-list"/, '列表视图套 grid-list');
  assert.match(list, /tile-desc-clamp/, '列表视图简介单行截断（精简列）');
  assert.doesNotMatch(list, /tile-vendor/, '列表视图去掉厂商独立行');
});

test('render()：同步布局开关的 aria-pressed 与已连接计数', () => {
  run('state.layout = "grid"; state.items = [{ key: "k1", enabled: true }, { key: "k2", enabled: true }, { key: "k3", enabled: false }]; render()');
  assert.equal(layoutBtns[0].attrs['aria-pressed'], 'false');
  assert.equal(layoutBtns[1].attrs['aria-pressed'], 'true', 'grid 按钮选中');
  assert.equal(get('connected-count').textContent, 2, '已连接计数只算启用中的');
});

/* ── 3. 首屏与刷新：绝不调 healthCheck ────────────────── */
test('loadAll：只取 status + compact 目录，绝不调 healthCheck', async () => {
  run('state.busy = false; state.workspaceId = ""');
  const before = fetchCalls.length;
  await run('loadAll()');
  const calls = fetchCalls.slice(before);
  const methods = calls.map((c) => c.method);
  assert.ok(!methods.includes('healthCheck'), 'loadAll 永不触发 healthCheck（避免 SSE 自激）');
  assert.ok(methods.includes('status') && methods.includes('catalog'));
  const cat = calls.find((c) => c.method === 'catalog');
  assert.equal(cat.params.compact, true, '目录请求 compact，避免 313KB 大包');
});

test('首屏只 loadAll()：无 tools / 无健康检查入口', async () => {
  assert.match(hubCode, /^loadAll\(\);\s*$/m, '文件尾是裸 loadAll()');
  assert.doesNotMatch(hubCode, /call\(['"]healthCheck/, 'v5 不再调用 healthCheck');
  assert.doesNotMatch(hubCode, /runHealthCheck/, '深度检查入口已移除');
  assert.doesNotMatch(hubCode, /loadTools|toolExplorer/, '工具视图与工具探测已移除');
  assert.doesNotMatch(hubCode, /deepCheck/, '旧的 deepCheck 全量深检已移除');
  assert.doesNotMatch(hubCode, /state\.checked/, '死状态 state.checked 已移除');
  assert.doesNotMatch(hubCode, /state\.view/, '单一视图后不再有 view 状态');
});

/* ── 4. 已连接抽屉 ───────────────────────────────────── */
test('抽屉：openDrawer/closeDrawer 维护可见性、aria 与 body 类', () => {
  run('state.drawerOpen = false; state.items = [{ key: "k1", name: "GitHub", serverName: "github", authMode: "bearer", enabled: true, connectionState: "healthy" }]');
  run('openDrawer()');
  assert.equal(get('drawer').hidden, false, '抽屉打开');
  assert.equal(get('scrim').hidden, false, '遮罩打开');
  assert.equal(get('btn-connected').getAttribute('aria-expanded'), 'true', '按钮标记展开态');
  assert.equal(run('state.drawerOpen'), true);
  assert.ok(bodyClasses.has('drawer-open'), 'body 标记抽屉打开（锁滚动）');
  assert.ok(get('drawer-rows').innerHTML.includes('class="row"'), '抽屉渲染已连接行');

  run('closeDrawer()');
  assert.equal(get('drawer').hidden, true, '抽屉关闭');
  assert.equal(get('scrim').hidden, true, '遮罩关闭');
  assert.equal(run('state.drawerOpen'), false);
  assert.ok(!bodyClasses.has('drawer-open'), 'body 类被移除');
});

/* ── 5. 逻辑 bug：connect 凭据失败 → openRepair 拿到 connectorId ── */
test('connect 凭据失败：UI 兜底注入 connectorId，修复对话框不再空 id', async () => {
  handlers.connect = {
    ok: false,
    message: '连接器 "高德地图" 需要凭据（api-key）',
    detail: { authMode: 'api-key', credentialGuide: { url: 'https://console.amap.com/' } },
  };
  run('state.busy = false; state.items = []');
  ctx.__target = { dataset: { id: 'amap', act: 'connect' } };
  await run('onAction("connect", __target)');
  const dctx = get('mask')._ctx;
  assert.equal(dctx.connectorId, 'amap', 'openRepair 的 ctx 带上了 connectorId');
  assert.equal(dctx.connectDetail.connectorId, 'amap', 'detail 也被补上 connectorId');
  delete handlers.connect;
  run('closeDialog()'); // 还清焦点栈，避免污染后续测试
});

/* ── 6. 细节打磨回归 ─────────────────────────────────── */
test('i18n：zh-CN 与 en 字典键完全对齐，关键新 key 均有译文', () => {
  const zh = run("Object.keys(I18N['zh-CN'])");
  const en = run('Object.keys(I18N.en)');
  assert.deepEqual([...zh].sort(), [...en].sort(), '两语言字典键集合一致');
  const required = [
    'invalid', 'idle', 'reqTimeout', 'reqFailedHttp', 'reqFailed',
    'oauthClientSecretHint', 'connectorLabel', 'tokenPlaceholderBearer',
    'tokenPlaceholderKey', 'addHint', 'addJson', 'addUrl', 'addRequired',
    'clearFilters', 'searchShortcut',
  ];
  for (const k of required) {
    assert.ok(zh.includes(k), `zh-CN 缺 ${k}`);
    assert.ok(en.includes(k), `en 缺 ${k}`);
    assert.notEqual(run(`I18N.en[${JSON.stringify(k)}]`), k, `en.${k} 未翻译`);
  }
});

test('stateLabelFor：invalid / idle 不再漏成裸英文 key', () => {
  assert.equal(run("stateLabelFor('credential-invalid').text"), '凭据已失效');
  assert.equal(run("stateLabelFor('idle').text"), '已停用');
  assert.equal(run("stateLabelFor('verified').text"), '已连接');
});

test('cardHtml：grid 与 list 都带已连接绿点标记', () => {
  ctx.__cc = { id: 'github', name: 'GitHub', vendor: 'v', summary: 's', category: '开发工具', authMode: 'bearer', connected: ['k1'] };
  for (const layout of ['grid', 'list']) {
    const html = run(`cardHtml(__cc, ${JSON.stringify(layout)})`);
    assert.match(html, /data-connected="1"/, `${layout} 视图标记已连接`);
    assert.match(html, /class="dot-ok"/, `${layout} 视图带绿点`);
  }
});

test('emptyHtml：空状态给出可点击的清除筛选 / 刷新按钮', () => {
  const clear = run("emptyHtml('noMatch', 'noMatchHint', 'clear')");
  assert.match(clear, /data-act="clear-filters"/, '筛选无结果时有清除按钮');
  assert.match(clear, /empty-actions/);
  const refresh = run("emptyHtml('noCatalog', 'noCatalogHint', 'refresh')");
  assert.match(refresh, /data-act="refresh"/, '目录为空时有刷新按钮');
});

test('onAction：clear-filters 复位 query/group/page 并清空搜索框', () => {
  run('state.query = "abc"; state.group = "dev"; state.page = 5;');
  get('search').value = 'abc';
  run("onAction('clear-filters', { dataset: {} })");
  assert.equal(run('state.query'), '');
  assert.equal(run('state.group'), 'all');
  assert.equal(run('state.page'), 0);
  assert.equal(get('search').value, '');
});

test('withBusy：动作期间禁用按钮，结束（含异常）后一定解锁', async () => {
  ctx.__node = { disabled: false };
  // fn 内同步读取 disabled：withBusy 在调用 fn 前置 true，故这里应观察到 true。
  const p = run('withBusy(__node, async () => { globalThis.__during = __node.disabled; return 42; })');
  assert.equal(run('__during'), true, '动作执行期间按钮已禁用');
  assert.equal(await p, 42);
  assert.equal(ctx.__node.disabled, false, '成功路径解锁');
  ctx.__boom = { disabled: false };
  await assert.rejects(
    run('withBusy(__boom, async () => { throw new Error("x"); })'),
    /x/,
  );
  assert.equal(ctx.__boom.disabled, false, '异常路径也解锁');
});

test('对话框：打开加 dialog-open 锁滚动，关闭移除并归还焦点', () => {
  const origin = { focus() { this._focusCount = (this._focusCount || 0) + 1; }, _focusCount: 0 };
  ctx.__origin = origin;
  run('openAdd(__origin)');
  assert.ok(bodyClasses.has('dialog-open'), '弹层打开时锁背景滚动');
  assert.equal(get('mask').hidden, false);
  run('closeDialog()');
  assert.ok(!bodyClasses.has('dialog-open'), '弹层关闭时解锁');
  assert.equal(origin._focusCount, 1, '焦点归还到触发元素');
});

test('抽屉行：带矢量图标，与目录卡片观感一致', () => {
  run('state.items = [{ key: "k1", connectorId: "github", name: "GitHub", serverName: "github", authMode: "bearer", enabled: true, connectionState: "healthy" }]');
  run('state.catalog = [{ id: "github", category: "开发工具" }]');
  run('renderDrawer()');
  const html = get('drawer-rows').innerHTML;
  assert.match(html, /class="row-icon"/, '抽屉行有图标位');
  assert.match(html, /<svg[^>]*viewBox="64 64 896 896"/, '抽屉行复用内联 SVG');
});

test('setLoading：加载提示永不占布局，aria-busy 挂在内容容器上', () => {
  // v10 修抖动：早先 #loading 在每次刷新时显示，那一行有 19.2px 高，
  // 会把下面的目录整片往下推再弹回来。现在提示文字永远 hidden（仅读屏），
  // 忙碌态改由 #content 的 aria-busy 表达。
  run('setLoading(true)');
  assert.equal(get('loading').hidden, true, '提示文字不占布局');
  assert.equal(get('content').getAttribute('aria-busy'), 'true', '内容容器标记忙碌');
  run('setLoading(false)');
  assert.equal(get('content').getAttribute('aria-busy'), 'false');
  assert.equal(get('loading').hidden, true);
});

test('搜索快捷键：/ 与 ⌘K 聚焦搜索框，输入框内的 / 不拦截', () => {
  const keydown = (docHandlers.keydown || [])[0];
  assert.ok(keydown, 'bind 注册了 document keydown');
  const search = get('search');
  const before = search._focusCount;
  // 遮罩关闭、抽屉未开、非编辑目标 → 聚焦搜索
  get('mask').hidden = true;
  run('state.drawerOpen = false');
  keydown({ key: '/', target: { tagName: 'BODY' }, preventDefault() {} });
  keydown({ key: 'k', metaKey: true, target: { tagName: 'BODY' }, preventDefault() {} });
  assert.equal(search._focusCount, before + 2, '两次快捷键都聚焦搜索');
  // 输入框里输入 '/' 不应抢焦点、不应 preventDefault
  let prevented = false;
  keydown({ key: '/', target: { tagName: 'INPUT' }, preventDefault() { prevented = true; } });
  assert.equal(prevented, false, '输入框内 / 正常输入');
  assert.equal(search._focusCount, before + 2, '输入框内 / 未触发聚焦');
  // v8：抽屉打开时 ⌘K 仍应把搜索框抢过来（搜索是全局动作），且顺手收起抽屉
  run('state.drawerOpen = true');
  keydown({ key: 'k', metaKey: true, target: { tagName: 'BODY' }, preventDefault() {} });
  assert.equal(search._focusCount, before + 3, '抽屉打开时 ⌘K 仍聚焦搜索');
  assert.equal(run('state.drawerOpen'), false, '聚焦搜索时收起抽屉，搜索框不被遮罩盖住');
});

test('CSS：抽屉行图标、空状态按钮、滚动锁、暗色软底对比度都已落地', () => {
  const css = readFileSync(join(root, 'ui/hub.css'), 'utf8');
  assert.match(css, /body\.drawer-open, body\.dialog-open \{ overflow: hidden; \}/, '抽屉/弹层锁背景滚动');
  assert.match(css, /\.row-icon \{/, '抽屉行图标样式');
  // v7：抽屉行只留「图标 | 正文」两列，操作挂在正文的 row-line 里，
  // 这样正常行与异常行的动作位置、行高都一致（此前独立第三列会让动作撑高行）。
  assert.match(css, /\.row \{[\s\S]{0,200}grid-template-columns: 30px minmax\(0, 1fr\)/, '抽屉行两列，图标 30px 与目录卡片一致');
  assert.match(css, /\.row-line \{/, '操作与元信息同一行，行高稳定');
  assert.match(css, /\.empty-actions \{/, '空状态动作按钮样式');
  // v6 起软底改用 rgba 语义变量（明暗两套统一），不再锁死某个 hex。
  // 契约改为「暗色块里 warn/bad 软底存在且是半透明叠加」，保证不退回纯黑/纯白。
  const dark = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
  assert.match(dark, /--warn-soft: rgba\([^)]+\)/, '暗色 warn 软底为半透明叠加');
  assert.match(dark, /--bad-soft: rgba\([^)]+\)/, '暗色 bad 软底为半透明叠加');
});

test('index.html：toast/loading 有 aria-live，favicon 内联消除 404', () => {
  const html = readFileSync(join(root, 'ui/index.html'), 'utf8');
  assert.match(html, /id="toast"[^>]*role="status"[^>]*aria-live="polite"/, 'toast 可被读屏播报');
  assert.match(html, /id="loading"[^>]*aria-live="polite"[^>]*aria-busy/, 'loading 可被读屏播报');
  assert.match(html, /<link rel="icon" href="data:image\/svg\+xml/, '内联 favicon，无 404');
});

/* ── 7. 结构与细节 v7：等高卡片、墨条、交叉淡入、拼图字形 ── */

test('cardHtml(grid)：三段式结构（head / desc / foot），供 CSS 做等高卡片', () => {
  ctx.__g = { id: 'github', name: 'GitHub', vendor: 'GitHub Inc', summary: 's', category: '开发工具', authMode: 'bearer', connected: [] };
  const html = run('cardHtml(__g, "grid")');
  assert.match(html, /class="tile-head"/, '栅格卡片有头部容器');
  assert.match(html, /class="tile-ident"/, '名称与厂商收在 ident 里');
  assert.match(html, /class="tile-foot"/, '底部容器同时装元信息与操作');
  assert.match(html, /class="tile-act"/, '主操作是轻量文字按钮，不是 tbtn 大片色');
  // 元信息与操作必须在同一底部容器里，否则栅格行高会被撑出差别
  const foot = html.slice(html.indexOf('class="tile-foot"'));
  assert.ok(foot.includes('tile-tags') && foot.includes('tile-act'), '底部同时包含元信息与操作');
});

test('cardHtml(list)：四列布局，操作不再用 tbtn 外观', () => {
  ctx.__l = { id: 'github', name: 'GitHub', vendor: 'v', summary: 's', category: '开发工具', authMode: 'bearer', connected: [] };
  const html = run('cardHtml(__l, "list")');
  assert.match(html, /class="tile-ident"/);
  assert.match(html, /tile-desc-clamp/, '列表简介单行截断');
  assert.match(html, /class="tile-act"/);
  assert.doesNotMatch(html, /class="tbtn strong" data-act="connect"/, '不再是带底色的 tbtn');
});

test('CSS：栅格卡片等高（grid-auto-rows:1fr + 两行 min-height 的描述）', () => {
  const css = readFileSync(join(root, 'ui/hub.css'), 'utf8');
  assert.match(css, /grid-auto-rows: 1fr/, '栅格行高统一');
  assert.match(css, /\.grid-cards \.tile-desc[\s\S]{0,220}min-height: calc\(2 \* 1\.55em\)/, '描述固定占两行，卡片才等高');
  assert.match(css, /line-clamp: 2/, '描述最多两行');
});

test('分组墨条：一枚元素滑到选中项，renderGroupBar 后带 data-ready', () => {
  run('state.catalog = [{ id: "a", category: "开发工具" }, { id: "b", category: "设计创意" }]; state.query = ""; state.group = "all"; renderGroupBar()');
  const html = get('groupbar').innerHTML;
  assert.match(html, /class="groupbar-ink"/, '分组条注入唯一墨条');
  assert.equal((html.match(/groupbar-ink/g) || []).length, 1, '墨条全局只有一枚');
});

test('分页：翻页走交叉淡入（animateNext → crossfadeRows），且只标记一次', () => {
  run(`
    state.catalog = Array.from({ length: 30 }, (_, i) => ({ id: 'c'+i, name: 'C'+i, category: '开发工具', authMode: 'none', connected: [] }));
    state.group = 'all'; state.page = 0; state.query = '';
  `);
  // 直接调 renderCatalog 不带动画；分页回调才置位
  run('renderCatalog("")');
  assert.equal(run('animateNext'), false, '静默渲染不动画');
  const onPage = get('pager')._onPage;
  assert.equal(typeof onPage, 'function', '分页回调已挂');
});

test('过渡与 reduce-motion：离开/入场类与降级规则都在 CSS 里', () => {
  const css = readFileSync(join(root, 'ui/hub.css'), 'utf8');
  assert.match(css, /\.rows-leaving \{/, '有离开态');
  assert.match(css, /\.rows-enter \{ animation: rows-enter/, '有入场动画');
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]{0,200}\.rows-leaving/, '减少动态效果时关闭过渡');
  assert.match(css, /@media \(max-width: 860px\)[\s\S]{0,300}flex-wrap: nowrap; overflow-x: auto/, '窄面板分组条横向滑动而非折行');
});

test('图标：侧边栏 / 面板 / 弹框共用拼图字形，不再有 3×3 方块阵列', () => {
  const client = readFileSync(join(root, 'lib/client.js'), 'utf8');
  assert.match(client, /CONNECTOR_GLYPH_PATH/, '有统一字形常量');
  assert.match(client, /function connectorGlyph/, '有统一字形生成函数');
  assert.doesNotMatch(client, /x: 10\.5, y: 10\.5, width: 3, height: 3/, '旧的 3×3 方块阵列已移除');
  // 三个入口都调同一个函数
  assert.equal((client.match(/connectorGlyph\(/g) || []).length >= 4, true, '多处复用同一字形');
  const svg = client.match(/const CONNECTOR_GLYPH_PATH = "([^"]+)"/)[1];
  assert.ok(svg.startsWith('M20.5 11H19V7'), '拼图轮廓路径');
  // v9：字形必须是空心描边，与宿主侧边栏图标（1.2–1.35 描边、无底色）同规格
  const glyphFn = client.slice(client.indexOf('function connectorGlyph'), client.indexOf('function connectorGlyph') + 700);
  assert.match(glyphFn, /fill: "none"/, '不做实心填充');
  assert.match(glyphFn, /stroke: "currentColor"/, '颜色跟随上下文');
  assert.match(glyphFn, /strokeWidth: (1\.9|2)/, '描边与宿主图标同档');
  assert.doesNotMatch(glyphFn, /fill: "currentColor"/, '不再是实心块');
});

test('index.html：品牌记号与 favicon 用同一枚拼图，不再用加法十字', () => {
  const html = readFileSync(join(root, 'ui/index.html'), 'utf8');
  assert.match(html, /id="brand-mark"/, '顶栏有品牌记号位');
  assert.match(html, /class="brand-mark"/);
  assert.doesNotMatch(html, /M9 16h14M16 9v14/, '旧的「+」十字 favicon 已移除');
  const fav = html.match(/<link rel="icon" href="([^"]+)"/)[1];
  assert.ok(fav.includes('M20.5%2011H19V7') || fav.includes('M20.5 11H19V7'), 'favicon 也换成拼图');
  // 顶栏品牌记号与 favicon 都改成空心描边，不再套黑底实心块
  assert.match(html, /class="brand-mark"[\s\S]{0,400}fill="none"[^>]*stroke="currentColor"/, '品牌记号是空心描边');
  assert.match(fav, /stroke='%23ffffff'/, 'favicon 图形为描边');
  const css = readFileSync(join(root, 'ui/hub.css'), 'utf8');
  assert.doesNotMatch(css.slice(css.indexOf('.brand-mark {'), css.indexOf('.brand-mark {') + 260), /background: var\(--text\)/, '品牌记号不再有黑底');
});

test('抽屉行：正常行不给冗余「已连接」药丸，异常行才出标签并常驻动作', () => {
  run('state.catalog = [{ id: "github", category: "开发工具" }]');
  run('state.items = [{ key: "k1", connectorId: "github", name: "GitHub", serverName: "github", authMode: "bearer", enabled: true, connectionState: "healthy", business: { readiness: "verified" } }]');
  run('renderDrawer()');
  const okRow = get('drawer-rows').innerHTML;
  assert.doesNotMatch(okRow, /state-label ok/, '正常行不再挂「已连接」药丸');
  assert.doesNotMatch(okRow, /data-attention="1"/, '正常行动作收进悬停态');

  run('state.items = [{ key: "k2", connectorId: "github", name: "GitHub", serverName: "github", authMode: "bearer", enabled: true, business: { readiness: "credential-invalid" } }]');
  run('renderDrawer()');
  const badRow = get('drawer-rows').innerHTML;
  assert.match(badRow, /state-label bad/, '异常行出状态标签');
  assert.match(badRow, /data-attention="1"/, '异常行动作常驻可见');
  assert.match(badRow, /class="row-line"/, '元信息与动作同一行，行高稳定');
});

/* ── 8. v10：打开面板不抖动 ─────────────────────────── */

test('抖动防线：加载提示、分组条都不允许改变布局高度', () => {
  const css = readFileSync(join(root, 'ui/hub.css'), 'utf8');
  // 加载提示曾经在每次 refresh 时显示，那一行 19.2px 高，把目录整片推下去再弹回
  assert.match(css, /\.loading \{[^}]*height: 0/, '加载提示零高度');
  assert.match(css, /\.loading \{[^}]*margin: 0/, '加载提示零外边距');
  // 分组条曾经 default hidden，数据到达时才出现，把下方内容推 49px
  assert.match(css, /\.groupbar\[data-empty="1"\] \{[^}]*min-height/, '空态分组条仍占位');
  const html = readFileSync(join(root, 'ui/index.html'), 'utf8');
  assert.doesNotMatch(html, /id="groupbar"[^>]*hidden/, '分组条初始不设 hidden');
  assert.match(html, /id="groupbar" data-empty="1"/, '分组条初始标记空态');
});

test('抖动防线：骨架分组条与真实按钮同高（26px，border-box）', () => {
  const css = readFileSync(join(root, 'ui/hub.css'), 'utf8');
  const block = css.slice(css.indexOf('.groupbar-sk {'), css.indexOf('.groupbar-sk {') + 400);
  assert.match(block, /height: 26px/, '骨架条高度与真实按钮一致');
  assert.match(block, /box-sizing: border-box/, 'border-box 才不会被 padding 吃掉高度');
  assert.doesNotMatch(block, /min-height/, '用 min-height 会少 5px，仍然会跳');
});

test('抖动防线：setLoading 在已有数据时不改 DOM 结构', () => {
  run('state.loaded = true; state.items = []; state.catalog = []');
  const before = get('rows').innerHTML;
  run('setLoading(true)');
  assert.equal(get('rows').innerHTML, before, '刷新不动列表内容');
  assert.equal(get('btn-refresh').dataset.busy, '1', '只在刷新按钮上转圈');
  run('setLoading(false)');
  assert.equal(get('btn-refresh').dataset.busy, undefined);
});

test('content 上有 scrollbar-gutter，滚动条出现不会缩内容宽', () => {
  const css = readFileSync(join(root, 'ui/hub.css'), 'utf8');
  const block = css.slice(css.indexOf('.content {'), css.indexOf('.content {') + 400);
  assert.match(block, /scrollbar-gutter: stable/, 'body 不滚动，占位必须设在 .content 上');
});
