/**
 * v5 面板的回归测试（极简：目录 + 已连接抽屉）
 *   1. 图标：icons.js 提供真实内联 SVG（不再是首字母占位），按 id / 类目映射，
 *      目录自带 URL icon 用 <img>；历史遗留路径归一；cardHtml 接上图标。
 *   2. 双布局：state.layout 决定 renderCatalog 用 grid-list / grid-cards，
 *      列表精简列（无厂商独立行）、栅格保留完整信息。
 *   3. 首屏：只 loadAll()（status + compact 目录），**全程不调 healthCheck**。
 *   4. 抽屉：已连接应用收进右上角抽屉，openDrawer/closeDrawer 维护可见性与 aria。
 *   5. 逻辑 bug：connect 凭据失败时 openRepair 能拿到 connectorId（含 UI 兜底）。
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
  addEventListener() {}, focus() {},
  setAttribute(k, v) { this.attrs[k] = String(v); },
  getAttribute(k) { return this.attrs[k]; },
  removeAttribute(k) { delete this.attrs[k]; },
  querySelector() { return null; }, querySelectorAll() { return []; },
});
const get = (id) => { if (!nodes.has(id)) nodes.set(id, makeNode(id)); return nodes.get(id); };
get('layout-switch').querySelectorAll = () => layoutBtns;

const rootStyleProps = new Map();
const bodyClasses = new Set();
const document = {
  title: '', hidden: false,
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
  addEventListener() {},
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
});
