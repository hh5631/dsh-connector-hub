/**
 * hub.js 纯函数逻辑回归（v5）
 *
 * v5 只有「目录」一个视图：分组、分页、卡片、字体同步都基于 catalog 计算。
 * 工具视图、左侧导航、健康检查已移除，对应断言不再存在。
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 极简 DOM 桩：让 hub.js 能跑完初始化，然后我们调用它的纯函数
const nodes = new Map();
const makeNode = (id) => ({
  id, hidden: false, textContent: '', innerHTML: '', value: '', placeholder: '',
  dataset: {}, options: { length: 0 }, disabled: false, className: '',
  _signature: undefined, _timer: null, _onPage: null,
  addEventListener() {}, setAttribute() {}, focus() {}, querySelector() { return null; },
  querySelectorAll() { return []; },
});
const get = (id) => { if (!nodes.has(id)) nodes.set(id, makeNode(id)); return nodes.get(id); };
const rootStyleProps = new Map();
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
  body: { classList: { add() {}, remove() {} } },
  getElementById: get,
  querySelectorAll: () => [],
  addEventListener() {},
  createElement: () => makeNode('tmp'),
};
const window = {
  location: { origin: 'http://127.0.0.1:4173', search: '' },
  __CONNECTOR_HUB_LOCALE__: 'zh-CN',
  parent: { postMessage() {} },
  addEventListener() {},
};
const location = window.location;
const fetchCalls = [];
const fetchImpl = async (url, opts) => {
  const body = JSON.parse(opts.body);
  fetchCalls.push(body);
  const detail = (items) => ({ ok: true, detail: { items } });
  if (body.method === 'status') return { ok: true, json: async () => detail([]) };
  if (body.method === 'catalog') return { ok: true, json: async () => detail([]) };
  return { ok: true, json: async () => ({ ok: true, detail: {} }) };
};
class EventSource { addEventListener() {} close() {} }
const ctx = {
  document, window, location, fetch: fetchImpl, EventSource,
  URLSearchParams, setTimeout, clearTimeout, AbortController,
  confirm: () => false, console,
};
ctx.globalThis = ctx;
vm.createContext(ctx);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const code = readFileSync(join(root, 'ui/hub.js'), 'utf8');
vm.runInContext(code, ctx, { filename: 'hub.js' });

test('hub.js UI 逻辑', async () => {
  const run = (expr) => vm.runInContext(expr, ctx);
  const S = new Proxy({}, {
    get: (_, k) => run(`state.${String(k)}`),
    set: (_, k, v) => { ctx.__tmp = v; run(`state.${String(k)} = globalThis.__tmp`); return true; },
  });

  assert(S !== undefined, 'state 初始化');
  assert(S.pageSize === 12, '目录每页 12 条');

  // ── 目录分页 ──
  S.catalog = Array.from({ length: 30 }, (_, i) => ({
    id: `c${i}`, name: `连接器${i}`, category: '开发工具', authMode: 'none',
    vendor: 'v', summary: 's', connected: [],
  }));
  S.group = 'all'; S.page = 0; S.query = '';
  ctx.renderCatalog('');
  let tiles = (get('rows').innerHTML.match(/class="tile"/g) || []).length;
  assert.equal(tiles, 12, `第 1 页渲染 12 张卡（实际 ${tiles}）`);
  assert.equal(get('pager').hidden, false, '分页器显示');
  assert.ok(get('pager').innerHTML.includes('第 1–12 条，共 30 条'), '分页文案正确: ' + get('pager').innerHTML.match(/第[^<]*/)?.[0]);

  S.page = 2;
  ctx.renderCatalog('');
  tiles = (get('rows').innerHTML.match(/class="tile"/g) || []).length;
  assert.equal(tiles, 6, `第 3 页渲染 6 张卡（实际 ${tiles}）`);
  assert.ok(get('pager').innerHTML.includes('第 25–30 条'), '末页文案正确');

  // 数据变少时页码自动收回最后一页
  S.catalog = S.catalog.slice(0, 13);
  S.page = 2;
  ctx.renderCatalog('');
  assert.equal(S.page, 1, '页码越界回落到最后一页');

  // ── 搜索过滤 ──
  S.catalog = [
    { id: 'github', name: 'GitHub', category: '开发工具', authMode: 'bearer', vendor: 'GitHub', summary: '代码托管', connected: [] },
    { id: 'figma', name: 'Figma', category: '设计创意', authMode: 'oauth2-pkce', vendor: 'Figma', summary: '设计协作', connected: [] },
  ];
  S.group = 'all'; S.page = 0;
  ctx.renderCatalog('fig');
  assert.equal((get('rows').innerHTML.match(/class="tile"/g) || []).length, 1, '搜索命中 1 条');
  assert.ok(get('rows').innerHTML.includes('Figma'));

  // ── 分组条：按目录统计，只显示非空组 ──
  S.catalog = [
    { id: 'a', name: 'A', category: '开发工具', authMode: 'none', connected: [] },
    { id: 'b', name: 'B', category: '设计创意', authMode: 'none', connected: [] },
  ];
  S.query = '';
  ctx.renderGroupBar();
  const bar = get('groupbar').innerHTML;
  assert.ok(bar.includes('data-group="dev"') && bar.includes('data-group="design"'), '分组条含 开发/设计 两组');
  assert.ok(bar.includes('data-group="all"'), '分组条含「全部」');
  assert.equal(get('groupbar').hidden, false, '有数据时显示分组条');

  // 切到某组后标题换成组名
  S.group = 'dev'; S.page = 0;
  ctx.renderCatalog('');
  assert.equal(get('list-title').textContent, '开发工具', '分组标题正确: ' + get('list-title').textContent);
  assert.equal((get('rows').innerHTML.match(/class="tile"/g) || []).length, 1, '分组只显示该组条目');

  // 空目录 → 分组条隐藏
  S.catalog = []; S.group = 'all';
  ctx.renderGroupBar();
  assert.equal(get('groupbar').hidden, true, '目录为空时隐藏分组条');

  // ── 分类映射 ──
  S.catalog = [{ id: 'a', category: '开发工具' }, { id: 'b', category: '设计创意' }];
  assert.equal(run(`groupOf({ connectorId: 'a', kind: 'manual' })`), 'dev', 'groupOf 映射 开发工具');
  assert.equal(run(`groupOf({ connectorId: 'b', kind: 'manual' })`), 'design', 'groupOf 映射 设计创意');
  assert.equal(run(`groupOf({ connectorId: 'zz', kind: 'manual' })`), 'custom', 'groupOf 未匹配归 自定义');
  assert.equal(run(`groupOf({ connectorId: 'a', kind: 'catalog' })`), 'dev', 'groupOf 目录来源按 category 映射');
  assert.equal(run(`groupLabel('design')`), '设计创意', 'groupLabel 中文');
  assert.equal(run(`CATEGORY_GROUP['地图出行']`), 'efficiency', '未知中文类目有兜底映射');

  // ── 已连接标记 ──
  S.catalog = [
    { id: 'github', name: 'GitHub', category: '开发工具', authMode: 'bearer', connected: ['github-1'] },
    { id: 'figma', name: 'Figma', category: '设计创意', authMode: 'oauth2-pkce', connected: [] },
  ];
  S.group = 'all'; S.page = 0;
  ctx.renderCatalog('');
  const html = get('rows').innerHTML;
  assert.ok(html.includes('data-connected="1"'), '已连接的目录项带 data-connected');
  assert.equal((html.match(/data-connected="1"/g) || []).length, 1, '只有已连接的那条被标记');

  // ── 抽屉：已连接列表 ──
  S.items = [
    { key: 'k1', name: 'GitHub', connectorId: 'github', serverName: 'github', authMode: 'bearer', enabled: true, connectionState: 'healthy' },
    { key: 'k2', name: '高德', connectorId: 'amap', serverName: 'amap', authMode: 'api-key', enabled: true, connectionState: 'reauth' },
  ];
  ctx.renderDrawer();
  const drawer = get('drawer-rows').innerHTML;
  assert.equal((drawer.match(/class="row"/g) || []).length, 2, '抽屉渲染 2 条连接');
  assert.ok(drawer.includes('data-readiness="credential-invalid"'), '失效凭据标记为 credential-invalid');
  assert.ok(get('drawer-stats').innerHTML.includes('stat bad'), '异常计数出现在抽屉统计里');
  assert.ok(get('drawer-stats').innerHTML.includes('异常'), '异常计数带文案');

  S.items = [];
  ctx.renderDrawer();
  assert.ok(get('drawer-rows').innerHTML.includes('empty'), '无连接时展示空状态');

  // ── 宿主字体同步（消息端到端另见 font-sync.test.mjs）──
  ctx.applyHostFonts({ text: '"Noto Sans", sans-serif', code: '"JetBrains Mono", monospace', contentSize: '16px' });
  assert.equal(rootStyleProps.get('--dsh-font-family-text'), '"Noto Sans", sans-serif', '字体：text 写入 :root');
  assert.equal(rootStyleProps.get('--dsh-font-family-code'), '"JetBrains Mono", monospace', '字体：code 写入 :root');
  assert.equal(rootStyleProps.get('--dsh-content-font-size'), '16px', '字体：字号写入 :root');

  ctx.applyHostFonts({ text: '', code: '', contentSize: '' });
  assert(!rootStyleProps.has('--dsh-font-family-text'), '字体：空值移除属性（回退系统栈）');

  ctx.applyHostFonts(null);
  ctx.applyHostFonts({ text: 123, code: {}, contentSize: [] });
  assert(!rootStyleProps.has('--dsh-font-family-code'), '字体：非字符串入参被忽略');

  ctx.applyHostFonts({ text: 'x'.repeat(999), code: 'ok', contentSize: '16px' });
  assert.equal(rootStyleProps.get('--dsh-font-family-text').length, 400, '字体：超长值被截断到 400');
});
