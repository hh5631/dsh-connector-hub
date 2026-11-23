/**
 * 面板流畅度回归测试（v11）
 *
 * 三处「用户能直接感觉到卡顿」的热点：
 *   1. 搜索逐键输入：state 立刻更新，但重绘压到下一帧（scheduleRender），
 *      同一帧内多次输入只重绘一次。
 *   2. 冗余重绘：rows / groupbar / drawer / pager 在 HTML 无变化时不再重写
 *      innerHTML（重写会丢掉节点、滚动位置与 hover 状态，并触发整页重排）。
 *   3. SSE 刷新：后端事件类别是 connections（复数），早先只认 connection，
 *      导致「连上后自动刷新」整条路径是死的；且连接类事件不必重拉 CDN 目录。
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const nodes = new Map();
const makeNode = (id) => ({
  id, hidden: false, textContent: '', innerHTML: '', value: '', placeholder: '',
  dataset: {}, options: { length: 0 }, disabled: false, className: '',
  _timer: null, _onPage: null, attrs: {}, writes: 0,
  addEventListener() {}, focus() {}, select() {},
  setAttribute(k, v) { this.attrs[k] = String(v); },
  getAttribute(k) { return this.attrs[k]; },
  removeAttribute(k) { delete this.attrs[k]; },
  querySelector() { return null; }, querySelectorAll() { return []; },
});
/** innerHTML 写入计数：用来断言「内容没变就不写 DOM」。 */
const get = (id) => {
  if (!nodes.has(id)) {
    const node = makeNode(id);
    let raw = '';
    Object.defineProperty(node, 'innerHTML', {
      get() { return raw; },
      set(v) { raw = String(v); node.writes++; },
    });
    nodes.set(id, node);
  }
  return nodes.get(id);
};

const document = {
  title: '', hidden: false, activeElement: null,
  documentElement: {
    lang: 'zh-CN',
    style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' },
  },
  body: { classList: { add() {}, remove() {}, contains: () => false } },
  getElementById: get,
  querySelectorAll: () => [],
  addEventListener() {},
  createElement: () => makeNode('tmp'),
};
const fetchCalls = [];
const handlers = {};
const detail = (items) => ({ ok: true, detail: { items } });
const fetchImpl = async (url, opts) => {
  const body = JSON.parse(opts.body);
  fetchCalls.push(body);
  const h = handlers[body.method];
  if (h !== undefined) return { ok: true, json: async () => typeof h === 'function' ? h(body.params) : h };
  if (body.method === 'status' || body.method === 'catalog') return { ok: true, json: async () => detail([]) };
  return { ok: true, json: async () => ({ ok: true, detail: {} }) };
};
const esHandlers = {};
class EventSource {
  constructor() { EventSource.instance = this; }
  addEventListener(type, fn) { esHandlers[type] = fn; }
  close() {}
}
const window = {
  location: { origin: 'http://127.0.0.1:4173', search: '' },
  __CONNECTOR_HUB_LOCALE__: 'zh-CN',
  parent: { postMessage() {} },
  addEventListener() {},
};
const ctx = {
  document, window, location: window.location, fetch: fetchImpl, EventSource,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  URLSearchParams, setTimeout, clearTimeout, AbortController,
  confirm: () => false, console,
};
ctx.globalThis = ctx;
vm.createContext(ctx);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
vm.runInContext(readFileSync(join(root, 'ui/icons.js'), 'utf8'), ctx, { filename: 'icons.js' });
vm.runInContext(readFileSync(join(root, 'ui/responsive.js'), 'utf8'), ctx, { filename: 'responsive.js' });
const hubCode = readFileSync(join(root, 'ui/hub.js'), 'utf8');
vm.runInContext(hubCode, ctx, { filename: 'hub.js' });
await new Promise((r) => setTimeout(r, 30));
const run = (expr) => vm.runInContext(expr, ctx);
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

test('搜索逐键输入：走 scheduleRender（帧合并），不做同步渲染', () => {
  assert.match(hubCode, /el\('search'\)\.addEventListener\('input'[\s\S]{0,220}scheduleRender\(\)/, 'input 事件走帧调度');
  assert.match(hubCode, /function scheduleRender\(\)/, '存在帧调度入口');
  assert.match(hubCode, /requestAnimationFrame\(run\)/, '优先用 rAF 合并同一帧内的重绘');
});

test('rows：内容相同时不重写 innerHTML（长列表重绘是最大的一次卡顿）', async () => {
  run('state.catalog = Array.from({ length: 30 }, (_, i) => ({ id: "c"+i, name: "C"+i, category: "开发工具", authMode: "none", connected: [] })); state.group = "all"; state.page = 0; state.query = "";');
  run('renderCatalog("")');
  const rows = get('rows');
  const before = rows.writes;
  assert.ok(before > 0, '首次渲染确实写了 DOM');
  run('renderCatalog("")');
  assert.equal(rows.writes, before, '重复渲染同一批数据不再写 innerHTML');
});

test('groupbar：内容相同时不重写 innerHTML（跳过按钮重建 + 强制布局测量）', () => {
  run('state.catalog = [{ id: "a", category: "开发工具" }, { id: "b", category: "设计创意" }]; state.query = ""; state.group = "all";');
  run('renderGroupBar()');
  const bar = get('groupbar');
  const before = bar.writes;
  run('renderGroupBar()');
  assert.equal(bar.writes, before, '同一批统计不再重写分组条');
  run('state.catalog = [{ id: "a", category: "开发工具" }, { id: "b", category: "设计创意" }, { id: "c", category: "开发工具" }];');
  run('renderGroupBar()');
  assert.equal(bar.writes, before + 1, '计数变化时才重写');
});

test('drawer：内容相同时保留滚动位置与 hover 状态', () => {
  run('state.catalog = [{ id: "github", category: "开发工具" }]');
  run('state.items = [{ key: "k1", connectorId: "github", name: "GitHub", serverName: "github", authMode: "bearer", enabled: true, connectionState: "healthy" }]');
  run('renderDrawer()');
  const body = get('drawer-rows');
  const before = body.writes;
  body.scrollTop = 120;
  run('renderDrawer()');
  assert.equal(body.writes, before, '相同内容不重写抽屉');
  assert.equal(body.scrollTop, 120, '滚动位置没有被重置');
});

test('loadAll({catalog:false})：只取 status，不重拉上游目录', async () => {
  run('state.busy = false; state.workspaceId = ""');
  const before = fetchCalls.length;
  await run('loadAll({ catalog: false })');
  const methods = fetchCalls.slice(before).map((c) => c.method);
  assert.ok(methods.includes('status'), '仍然取状态');
  assert.ok(!methods.includes('catalog'), '不重复拉 18KB 目录');
});

test('启用 / 停用连接：只重取 status，目录不受影响', async () => {
  handlers.setEnabled = { ok: true, message: 'ok' };
  run('state.busy = false; state.items = [{ key: "k1", connectorId: "github", name: "GitHub", serverName: "github", authMode: "bearer", enabled: true }]');
  const before = fetchCalls.length;
  ctx.__btn = { dataset: { key: 'k1' }, disabled: false };
  await run("onAction('disable', __btn)");
  const methods = fetchCalls.slice(before).map((c) => c.method);
  assert.ok(methods.includes('setEnabled'));
  assert.ok(methods.includes('status'), '动作后重取状态');
  assert.ok(!methods.includes('catalog'), '目录与启停无关，不再白拉');
  delete handlers.setEnabled;
});

test('已连接标记以 status 为准：启停后无需重拉目录，绿点也是对的', () => {
  run('state.catalog = [{ id: "github", name: "GitHub", category: "开发工具", authMode: "bearer", connected: [] }]');
  run('state.items = [{ key: "k1", connectorId: "github", name: "GitHub", enabled: true }]');
  run('render()');
  assert.match(get('rows').innerHTML, /data-connected="1"/, 'status 里有的连接器直接标为已连接');
  run('state.items = []; render()');
  assert.doesNotMatch(get('rows').innerHTML, /data-connected="1"/, '断开后立刻不再标记');
});

test('SSE：认后端真实的 connections 类别，且连接类事件不重拉目录', async () => {
  const onStatus = esHandlers.status;
  assert.equal(typeof onStatus, 'function', '订阅了 status 事件');
  run('state.busy = false; state.workspaceId = ""');
  const before = fetchCalls.length;
  onStatus({ data: JSON.stringify({ type: 'connections', sequence: 1 }) });
  await tick(260);
  const methods = fetchCalls.slice(before).map((c) => c.method);
  assert.ok(methods.includes('status'), '连接事件触发状态刷新（此前 connection 拼错，永远不触发）');
  assert.ok(!methods.includes('catalog'), '连接事件不重拉目录');

  const before2 = fetchCalls.length;
  onStatus({ data: JSON.stringify({ type: 'catalog', sequence: 2 }) });
  await tick(260);
  const methods2 = fetchCalls.slice(before2).map((c) => c.method);
  assert.ok(methods2.includes('catalog'), '目录类事件才重拉目录');
});

test('无关事件与隐藏页面：不发起任何请求', async () => {
  run('state.busy = false');
  const onStatus = esHandlers.status;
  const before = fetchCalls.length;
  onStatus({ data: JSON.stringify({ type: 'tools', sequence: 3 }) });
  await tick(200);
  assert.equal(fetchCalls.length, before, '工具类事件不触发面板重取');
});

test('切换工作区立即发新请求，迟到的旧响应不会覆盖状态', async () => {
  let resolveOld;
  const old = new Promise(resolve => { resolveOld = resolve; });
  handlers.status = ({ workspaceId }) => workspaceId === 'old' ? old : detail([{ key: 'current' }]);
  try {
    get('mask').hidden = true;
    run("state.workspaceId = 'old'");
    const oldLoad = run('loadAll()');
    run("changeWorkspace('new')");
    await tick();
    assert.equal(run('state.items[0]?.key'), 'current');
    resolveOld(detail([{ key: 'stale' }]));
    await oldLoad;
    assert.equal(run('state.items[0]?.key'), 'current');
    assert.equal(run('state.workspaceId'), 'new');
  } finally {
    resolveOld(detail([]));
    delete handlers.status;
  }
});
