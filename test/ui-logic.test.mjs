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
  if (body.method === 'toolExplorer') return { ok: true, json: async () => ({ ok: true, detail: { total: 0, items: [], connections: [] } }) };
  return { ok: true, json: async () => ({ ok: true, detail: {} }) };
};
class EventSource { addEventListener() {} close() {} }
const ctx = {
  document, window, location, fetch: fetchImpl, EventSource,
  URLSearchParams, setTimeout, clearTimeout, setTimeout, AbortController,
  confirm: () => false, console,
};
ctx.globalThis = ctx;
vm.createContext(ctx);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const code = readFileSync(join(root, 'ui/hub.js'), 'utf8');
vm.runInContext(code, ctx, { filename: 'hub.js' });

// ── 断言 ──────────────────────────────────────────────
test('hub.js UI 逻辑', async () => {
const run = (expr) => vm.runInContext(expr, ctx);
const S = new Proxy({}, {
  get: (_, k) => run(`state.${String(k)}`),
  set: (_, k, v) => { ctx.__tmp = v; run(`state.${String(k)} = globalThis.__tmp`); return true; },
});

  assert(S !== undefined, 'state 初始化');
  assert(S.pageSize === 8, '连接每页 8 条');
  assert(S.toolPageSize === 20, '工具每页 20 条');

// 分页切片
  S.items = Array.from({ length: 20 }, (_, i) => ({ key: `k${i}`, name: `连接${i}`, connectorId: 'x', serverName: 's', endpoint: '', authMode: 'none', enabled: true, kind: 'manual' }));
  S.catalog = [{ id: 'x', category: '开发工具' }];
  S.group = 'all'; S.page = 0; S.query = '';
ctx.renderConnections('');
  let rows = (get('rows').innerHTML.match(/class="row"/g) || []).length;
  assert(rows === 8, `第 1 页渲染 8 行（实际 ${rows}）`);
  assert(get('pager').hidden === false, '分页器显示');
  assert(get('pager').innerHTML.includes('第 1–8 条，共 20 条'), '分页文案正确: ' + get('pager').innerHTML.match(/第[^<]*/)?.[0]);

  S.page = 2;
ctx.renderConnections('');
  rows = (get('rows').innerHTML.match(/class="row"/g) || []).length;
  assert(rows === 4, `第 3 页渲染 4 行（实际 ${rows}）`);
  assert(get('pager').innerHTML.includes('第 17–20 条'), '末页文案正确');

// 分组：把 20 条分到两个分类
  S.items = Array.from({ length: 20 }, (_, i) => ({ key: `k${i}`, name: `连接${i}`, connectorId: i < 10 ? 'a' : 'b', serverName: 's', endpoint: '', authMode: 'none', enabled: true, kind: 'manual' }));
  S.catalog = [{ id: 'a', category: '开发工具' }, { id: 'b', category: '设计创意' }];
  S.page = 0;
ctx.renderGroupBar();
  const bar = get('groupbar').innerHTML;
  assert(bar.includes('data-group="dev"') && bar.includes('data-group="design"'), '分组条含 开发/设计 两组');
  assert(bar.includes('data-group="all"'), '分组条含「全部」');
  S.group = 'dev';
ctx.renderConnections('');
  rows = (get('rows').innerHTML.match(/class="row"/g) || []).length;
  assert(rows === 8, `切到「开发工具」组后按 8 条分页（实际 ${rows}）`);
  assert(get('list-title').textContent === '开发工具', '分组标题正确: ' + get('list-title').textContent);

// 目录分页
  S.catalog = Array.from({ length: 33 }, (_, i) => ({ id: `c${i}`, name: `连接器${i}`, category: '开发工具', authMode: 'none', vendor: 'v', summary: 's', connected: [] }));
  S.view = 'catalog'; S.group = 'all'; S.page = 0; S.query = '';
ctx.renderCatalog('');
  rows = (get('rows').innerHTML.match(/class="tile"/g) || []).length;
  assert(rows === 8, `目录第 1 页 8 条（实际 ${rows}）`);
  assert(get('pager').innerHTML.includes('共 33 条'), '目录分页总数正确');

// 分组标签与分类映射
// 目录分页测试覆盖了 catalog，这里重设回带分类的数据再验 groupOf
  S.catalog = [{ id: 'a', category: '开发工具' }, { id: 'b', category: '设计创意' }];
  assert(run(`groupOf({ connectorId: 'a', kind: 'manual' })`) === 'dev', 'groupOf 映射 开发工具');
  assert(run(`groupOf({ connectorId: 'b', kind: 'manual' })`) === 'design', 'groupOf 映射 设计创意');
  assert(run(`groupOf({ connectorId: 'zz', kind: 'manual' })`) === 'custom', 'groupOf 未匹配归 自定义');
  assert(run(`groupLabel('design')`) === '设计创意', 'groupLabel 中文');

  // ── 宿主字体同步（消息端到端另见 font-sync.test.mjs）──
  ctx.applyHostFonts({ text: '"Noto Sans", sans-serif', code: '"JetBrains Mono", monospace', contentSize: '16px' });
  assert(rootStyleProps.get('--dsh-font-family-text') === '"Noto Sans", sans-serif', '字体：text 写入 :root');
  assert(rootStyleProps.get('--dsh-font-family-code') === '"JetBrains Mono", monospace', '字体：code 写入 :root');
  assert(rootStyleProps.get('--dsh-content-font-size') === '16px', '字体：字号写入 :root');

  ctx.applyHostFonts({ text: '', code: '', contentSize: '' });
  assert(!rootStyleProps.has('--dsh-font-family-text'), '字体：空值移除属性（回退系统栈）');

  ctx.applyHostFonts(null);
  ctx.applyHostFonts({ text: 123, code: {}, contentSize: [] });
  assert(!rootStyleProps.has('--dsh-font-family-code'), '字体：非字符串入参被忽略');

  ctx.applyHostFonts({ text: 'x'.repeat(999), code: 'ok', contentSize: '16px' });
  assert(rootStyleProps.get('--dsh-font-family-text').length === 400, '字体：超长值被截断到 400');

  // ── 工具筛选参数 ──
  S.toolQuery = 'seedance'; S.toolServer = 'hub-seedance'; S.toolStatus = 'success'; S.toolPage = 2;
await ctx.loadTools();
  const toolCall = fetchCalls.filter((c) => c.method === 'toolExplorer').pop();
  assert(toolCall.params.query === 'seedance', '工具搜索词发给服务端');
  assert(toolCall.params.serverName === 'hub-seedance', '服务筛选发给服务端');
  assert(toolCall.params.status === 'success', '状态筛选发给服务端');
  assert(toolCall.params.offset === 40 && toolCall.params.limit === 20, '工具分页 offset/limit 正确');

});
