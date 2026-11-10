/* 连接器控制台 — 面板逻辑 v4
 * 契约：POST /connector-hub/api  {method, params}；GET /connector-hub/events（SSE invalidation）。
 * 业务失败 = HTTP 200 + {ok:false, message}。所有状态枚举按值判断，文案只展示不解析。
 * 本文件不读取、不回显任何凭据；修复凭据时只把用户新输入的值发给 repairCredentials。
 */

const API = '/connector-hub/api';
const EVENTS = '/connector-hub/events';

const TIMEOUTS = {
  connect: 145000, configure: 145000, importJson: 145000, installFromUrl: 145000,
  repairCredentials: 145000, reconfigureConnection: 145000, restoreSnapshot: 145000,
  setEnabled: 130000, healthCheck: 30000, toolsList: 30000, toolExplorer: 30000,
  catalog: 30000, status: 30000, _default: 30000,
};

async function call(method, params = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUTS[method] ?? TIMEOUTS._default);
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }),
      signal: controller.signal,
    });
    const data = await res.json();
    if (!res.ok && data.ok !== false) return { ok: false, message: `请求失败（HTTP ${res.status}）` };
    return data;
  } catch (error) {
    return { ok: false, message: error?.name === 'AbortError' ? '请求超时，请重试' : `请求失败：${error?.message || error}` };
  } finally { clearTimeout(timer); }
}

/* 连接按「用处」分组：优先用目录里的 category，自定义/JSON 连接归到「自定义」。 */
const GROUP_KEYS = ['all', 'design', 'dev', 'data', 'office', 'research', 'finance', 'legal', 'efficiency', 'other', 'custom'];
const GROUP_LABEL = {
  'zh-CN': {
    all: '全部', design: '设计创意', dev: '开发工具', data: '企业数据', office: '办公协作',
    research: '调研分析', finance: '金融投资', legal: '法律合规', efficiency: '效率工具',
    other: '其他', custom: '自定义',
  },
  en: {
    all: 'All', design: 'Design', dev: 'Developer', data: 'Enterprise data', office: 'Collaboration',
    research: 'Research', finance: 'Finance', legal: 'Legal', efficiency: 'Productivity',
    other: 'Other', custom: 'Custom',
  },
};
/** 目录 category（中文）→ 分组键 */
const CATEGORY_GROUP = {
  '设计创意': 'design', '开发工具': 'dev', '企业数据': 'data', '办公协作': 'office',
  '调研分析': 'research', '金融投资': 'finance', '法律合规': 'legal', '效率工具': 'efficiency',
  '地图出行': 'efficiency', '其他': 'other', '数据库': 'dev', 'AI 模型': 'dev',
};

const state = {
  view: 'connections',
  items: [],          // status.detail.items
  catalog: [],        // catalog.detail.items
  tools: null,        // toolExplorer.detail
  query: '',          // 顶栏搜索（连接/目录）
  toolQuery: '',      // 工具搜索
  toolServer: '',     // 工具按 serverName 筛选
  toolStatus: '',     // 工具按连接状态筛选
  group: 'all',       // 连接分组
  page: 0,            // 当前页（0 基）
  pageSize: 8,        // 连接/目录每页条数
  toolPage: 0,
  toolPageSize: 20,
  loading: false,
  busy: false,
  workspaceId: '',
  workspaces: [],
  checked: false,
};

const el = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ── 语言 ───────────────────────────────────────────── */
const LOCALE = (() => {
  try {
    const fromHost = window.__CONNECTOR_HUB_LOCALE__;
    const fromUrl = new URLSearchParams(location.search).get('uiLocale') || new URLSearchParams(location.search).get('locale');
    const raw = fromUrl || fromHost || document.documentElement.lang || 'zh-CN';
    return String(raw).toLowerCase().startsWith('en') ? 'en' : 'zh-CN';
  } catch { return 'zh-CN'; }
})();
const I18N = {
  'zh-CN': {
    brand: '连接器', connections: '连接', catalog: '目录', tools: '工具', subtitle: '外部服务接入控制台', workspace: '工作台',
    search: '搜索连接、服务或工具…', toolSearch: '搜索工具名或描述…', refresh: '刷新', check: '深度检查', add: '添加连接',
    overview: '业务健康总览', overviewSub: '颜色表示业务通道的真实状态，握手成功不代表凭据有效',
    verified: '业务已验证', unknown: '待确认', invalid: '凭据失效', idle: '未启用',
    noConnections: '还没有连接', noConnectionsHint: '去「目录」挑一个连接器，或用「添加连接」粘贴 JSON / URL。',
    noCatalog: '目录为空', noCatalogHint: '检查网络或点击刷新重新拉取目录。',
    noTools: '暂无工具缓存', noToolsHint: '连接成功并完成一次工具发现后，这里会列出可用工具。',
    noMatch: '没有匹配的内容', noMatchHint: '换一个关键词，或清除筛选条件。',
    repair: '修复凭据', repairTitle: '重新配置凭据', repairHint: '只替换 Token / API Key，URL、作用域、注入模式等其余配置保持不变。写入后会立即做一次业务级复验。',
    newToken: '新的 API Token', newKey: '新的 API Key', keyHeader: '头名（可选）',
    save: '保存并复验', cancel: '取消', connect: '连接', disconnect: '断开',
    enable: '启用', disable: '停用', detail: '详情', recheck: '重新检查',
    checkedOk: '深度检查完成', checkedFail: '深度检查未通过', repaired: '凭据已更新并通过复验',
    authBearer: 'Bearer Token', authApiKey: 'API Key', authOAuth: 'OAuth', authNone: '无需凭据',
    global: '全局', session: '按会话', scopeProject: '项目',
    credentialExpiring: '凭据即将过期', credentialExpired: '凭据已过期',
    businessVerified: '业务通道已验证', businessUnknown: '业务通道未确认',
    businessInvalid: '凭据已失效：握手正常，但真实调用被拒绝',
    deepProbe: '深度业务探针', deepProbeNote: '握手成功后追加一次只读业务调用，识别失效凭据。',
    hintReauth: '建议点击「修复凭据」填入新 Token，或重新授权。',
    confirmDisconnect: '确定断开这条连接吗？',
    prev: '上一页', next: '下一页', pageInfo: '第 {from}–{to} 条，共 {total} 条',
    allServers: '全部服务', allStatus: '全部状态', statusSuccess: '已连接', statusFailed: '异常', statusUnknown: '未知', statusPending: '待发现',
    toolCount: '{count} 个工具', perPage: '每页',
    whereToGet: '去哪里获取凭据', openGuide: '打开申请页面',
    reuseCli: '复用本机已登录凭据', reuseCliHint: '检测到本机 {labels} 已登录，可直接复用其授权，无需手工创建 Token。',
    cliChecking: '正在检测本机 CLI 登录状态…',
    oauthClientTitle: '此服务不支持自动注册客户端',
    oauthClientHint: '该服务的 OAuth 未提供动态客户端注册（DCR）。请填写你在该服务登记的 OAuth App 的 client_id（如为机密客户端还需 client_secret），之后就能用浏览器正常登录。',
    oauthClientId: 'OAuth Client ID', oauthClientSecret: 'OAuth Client Secret（可选）',
    oauthFlow: '授权方式', flowAuto: '自动', flowCode: '浏览器授权码', flowDevice: '设备码（输入短码）',
  },
  en: {
    brand: 'Connector', connections: 'Connections', catalog: 'Catalog', tools: 'Tools', subtitle: 'External service access', workspace: 'Workspace',
    search: 'Search connections, servers or tools…', toolSearch: 'Search tool names or descriptions…', refresh: 'Refresh', check: 'Deep check', add: 'Add connection',
    overview: 'Business health', overviewSub: 'Colors show the real state of the business channel; a successful handshake does not prove valid credentials',
    verified: 'Verified', unknown: 'Unconfirmed', invalid: 'Invalid credential', idle: 'Disabled',
    noConnections: 'No connections yet', noConnectionsHint: 'Pick a connector from the Catalog, or use Add connection to paste JSON / a URL.',
    noCatalog: 'Catalog is empty', noCatalogHint: 'Check the network or press Refresh to reload the catalog.',
    noTools: 'No tool cache yet', noToolsHint: 'After a successful connection and tool discovery, available tools appear here.',
    noMatch: 'Nothing matches', noMatchHint: 'Try another keyword, or clear the filters.',
    repair: 'Fix credentials', repairTitle: 'Update credentials', repairHint: 'Only the token / API key is replaced; URL, scope and injection mode stay unchanged. A business-level re-check runs immediately after saving.',
    newToken: 'New API token', newKey: 'New API key', keyHeader: 'Header name (optional)',
    save: 'Save & verify', cancel: 'Cancel', connect: 'Connect', disconnect: 'Disconnect',
    enable: 'Enable', disable: 'Disable', detail: 'Details', recheck: 'Recheck',
    checkedOk: 'Deep check complete', checkedFail: 'Deep check failed', repaired: 'Credentials updated and verified',
    authBearer: 'Bearer Token', authApiKey: 'API Key', authOAuth: 'OAuth', authNone: 'No credential',
    global: 'Global', session: 'Per session', scopeProject: 'Project',
    credentialExpiring: 'Credential expiring soon', credentialExpired: 'Credential expired',
    businessVerified: 'Business channel verified', businessUnknown: 'Business channel unconfirmed',
    businessInvalid: 'Credential invalid: handshake succeeded but real calls are rejected',
    deepProbe: 'Deep business probe', deepProbeNote: 'Append a side-effect-free business probe for healthy handshakes to catch invalid credentials.',
    hintReauth: 'Click Fix credentials to enter a new token, or reauthorize.',
    confirmDisconnect: 'Disconnect this connection?',
    prev: 'Previous', next: 'Next', pageInfo: '{from}–{to} of {total}',
    allServers: 'All servers', allStatus: 'All states', statusSuccess: 'Connected', statusFailed: 'Failed', statusUnknown: 'Unknown', statusPending: 'Pending',
    toolCount: '{count} tools', perPage: 'Per page',
    whereToGet: 'Where to get credentials', openGuide: 'Open signup page',
    reuseCli: 'Reuse local CLI login', reuseCliHint: 'Detected a logged-in {labels} on this machine; its authorization can be reused instead of creating a token manually.',
    cliChecking: 'Checking local CLI login state…',
    oauthClientTitle: 'This service does not support automatic client registration',
    oauthClientHint: 'This OAuth server does not offer Dynamic Client Registration (DCR). Enter the client_id of the OAuth App you registered with the service (plus client_secret for confidential clients) and browser sign-in will work.',
    oauthClientId: 'OAuth Client ID', oauthClientSecret: 'OAuth Client Secret (optional)',
    oauthFlow: 'Authorization flow', flowAuto: 'Auto', flowCode: 'Browser authorization code', flowDevice: 'Device code (enter a short code)',
  },
};
const t = (key, params) => {
  let s = I18N[LOCALE]?.[key] ?? I18N['zh-CN'][key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
};
const groupLabel = (key) => GROUP_LABEL[LOCALE]?.[key] ?? GROUP_LABEL['zh-CN'][key] ?? key;

function toast(message, kind = '') {
  const node = el('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(node._timer);
  node._timer = setTimeout(() => { node.hidden = true; }, 4200);
}

/* ── 数据加载 ───────────────────────────────────────── */
async function loadAll({ deepCheck = false } = {}) {
  if (state.busy) return;
  state.busy = true;
  setLoading(true);
  try {
    const workspaceParams = state.workspaceId ? { workspaceId: state.workspaceId } : {};
    const [statusRes, catalogRes] = await Promise.all([
      call('status', workspaceParams),
      call('catalog', workspaceParams),
    ]);
    if (statusRes.ok) state.items = statusRes.detail?.items ?? [];
    else toast(statusRes.message, 'bad');
    if (catalogRes.ok) state.catalog = catalogRes.detail?.items ?? [];
    if (deepCheck && state.items.some((it) => it.enabled)) {
      const check = await call('healthCheck', {});
      toast(check.ok ? t('checkedOk') : (check.message || t('checkedFail')));
      const again = await call('status', workspaceParams);
      if (again.ok) state.items = again.detail?.items ?? [];
      state.checked = true;
    }
    if (state.view === 'tools') await loadTools();
    render();
  } finally { state.busy = false; setLoading(false); }
}

async function loadTools() {
  const params = {
    ...(state.workspaceId ? { workspaceId: state.workspaceId } : {}),
    query: state.toolQuery || undefined,
    serverName: state.toolServer || undefined,
    status: state.toolStatus || undefined,
    offset: state.toolPage * state.toolPageSize,
    limit: state.toolPageSize,
  };
  const res = await call('toolExplorer', params);
  state.tools = res.ok ? res.detail : { total: 0, items: [], connections: [] };
  if (state.view === 'tools') syncToolFilters();
}

function setLoading(on) {
  state.loading = on;
  const node = el('loading');
  if (node) node.hidden = !on;
}

/* ── 状态推导 ───────────────────────────────────────── */
function readinessOf(item) {
  if (item.enabled === false) return 'idle';
  if (item.business?.readiness === 'credential-invalid' || item.connectionState === 'reauth' || item.diagnostic?.code === 'credential-invalid') return 'credential-invalid';
  if (item.business?.readiness === 'verified') return 'verified';
  if (item.connectionState === 'unavailable' || item.connectionState === 'degraded' || item.connectionState === 'recovering') return 'credential-invalid';
  return 'unknown';
}
function stateLabelFor(r) {
  const cls = r === 'verified' ? 'ok' : r === 'credential-invalid' ? 'bad' : r === 'idle' ? 'idle' : 'warn';
  return { cls, text: t(r === 'verified' ? 'verified' : r === 'credential-invalid' ? 'invalid' : r === 'idle' ? 'idle' : 'unknown') };
}
function authLabel(item) {
  const map = { bearer: t('authBearer'), 'api-key': t('authApiKey'), oauth: t('authOAuth'), none: t('authNone') };
  return map[item.authMode] ?? item.authMode;
}
function scopeLabel(item) { return item.scope?.label ? esc(item.scope.label) : t('global'); }

/** 连接的用处：从目录 category 映射；找不到归 custom。 */
function groupOf(item) {
  const cat = state.catalog.find((c) => c.id === item.connectorId)?.category;
  if (cat && CATEGORY_GROUP[cat]) return CATEGORY_GROUP[cat];
  if (item.kind === 'manual' || item.kind === 'json' || !cat) return 'custom';
  return 'other';
}

/* ── 渲染总入口 ─────────────────────────────────────── */
function render() {
  renderNav();
  renderOverview();
  el('overview').hidden = state.view !== 'connections';
  el('groupbar').hidden = state.view === 'tools';
  el('toolbar').hidden = state.view !== 'tools';
  el('view-title').textContent = t(state.view === 'connections' ? 'connections' : state.view === 'catalog' ? 'catalog' : 'tools');
  const q = state.query.trim().toLowerCase();
  if (state.view === 'connections') { renderGroupBar(); renderConnections(q); }
  else if (state.view === 'catalog') { renderGroupBar(); renderCatalog(q); }
  else renderToolView();
}

function renderNav() {
  for (const btn of document.querySelectorAll('.nav button')) {
    btn.setAttribute('aria-current', btn.dataset.view === state.view ? 'page' : 'false');
  }
  el('nav-connections-count').textContent = state.items.filter((i) => i.enabled !== false).length || '';
  el('nav-catalog-count').textContent = state.catalog.length || '';
  el('nav-tools-count').textContent = state.tools?.total ?? '';
}

function renderOverview() {
  const buckets = { verified: 0, unknown: 0, 'credential-invalid': 0, idle: 0 };
  for (const item of state.items) { const r = readinessOf(item); buckets[r] = (buckets[r] ?? 0) + 1; }
  const total = state.items.length || 1;
  el('stat-ok').textContent = buckets.verified;
  el('stat-warn').textContent = buckets.unknown;
  el('stat-bad').textContent = buckets['credential-invalid'];
  const pct = (n) => `${(n / total) * 100}%`;
  el('signalbar').innerHTML =
    `<i class="s-ok" style="width:${pct(buckets.verified)}"></i>` +
    `<i class="s-warn" style="width:${pct(buckets.unknown)}"></i>` +
    `<i class="s-bad" style="width:${pct(buckets['credential-invalid'])}"></i>` +
    `<i class="s-idle" style="width:${pct(buckets.idle)}"></i>`;
}

/** 分组条：按当前视图的数据统计每个分组的数量，只显示非空组。 */
function renderGroupBar() {
  const q = state.query.trim().toLowerCase();
  const counts = new Map();
  if (state.view === 'connections') {
    for (const item of state.items) {
      if (q && ![item.name, item.serverName, item.connectorId, item.endpoint].some((v) => String(v ?? '').toLowerCase().includes(q))) continue;
      const g = groupOf(item);
      counts.set(g, (counts.get(g) ?? 0) + 1);
      counts.set('all', (counts.get('all') ?? 0) + 1);
    }
  } else {
    for (const c of state.catalog) {
      if (q && ![c.name, c.id, c.vendor, c.summary, c.category].some((v) => String(v ?? '').toLowerCase().includes(q))) continue;
      const g = CATEGORY_GROUP[c.category] ?? 'other';
      counts.set(g, (counts.get(g) ?? 0) + 1);
      counts.set('all', (counts.get('all') ?? 0) + 1);
    }
  }
  const keys = GROUP_KEYS.filter((k) => k === 'all' || counts.has(k));
  // 当前选中组没有数据时回落到全部
  if (!keys.includes(state.group)) state.group = 'all';
  el('groupbar').innerHTML = keys.map((k) =>
    `<button type="button" data-group="${k}" aria-pressed="${state.group === k}">${groupLabel(k)}<span class="n">${counts.get(k) ?? 0}</span></button>`
  ).join('');
}

/** 通用分页渲染。 */
function renderPager(total, page, pageSize, onPage) {
  const pager = el('pager');
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) { pager.hidden = true; pager.innerHTML = ''; return; }
  const from = page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);
  pager.hidden = false;
  pager.innerHTML = `
    <button class="tbtn" data-page="prev" ${page <= 0 ? 'disabled' : ''}>${t('prev')}</button>
    <span class="info">${t('pageInfo', { from, to, total })}</span>
    <span class="spacer"></span>
    <span class="info">${page + 1} / ${pages}</span>
    <button class="tbtn" data-page="next" ${page + 1 >= pages ? 'disabled' : ''}>${t('next')}</button>`;
  pager._onPage = onPage;
}

function pageSlice(list, page, pageSize) {
  const pages = Math.max(1, Math.ceil(list.length / pageSize));
  const p = Math.min(Math.max(0, page), pages - 1);
  if (p !== page) { /* 数据变少时自动回退，由调用方写回 */ }
  return { p, items: list.slice(p * pageSize, p * pageSize + pageSize) };
}

function emptyHtml(titleKey, hintKey) {
  return `<div class="empty"><strong>${t(titleKey)}</strong>${t(hintKey)}</div>`;
}

/* ── 连接列表：分组 + 分页 ───────────────────────────── */
function renderConnections(q) {
  let list = state.items.filter((item) => !q || [item.name, item.serverName, item.connectorId, item.endpoint].some((v) => String(v ?? '').toLowerCase().includes(q)));
  if (state.group !== 'all') list = list.filter((item) => groupOf(item) === state.group);

  const slice = pageSlice(list, state.page, state.pageSize);
  state.page = slice.p;
  el('list-title').textContent = state.group === 'all' ? t('connections') : groupLabel(state.group);
  el('list-count').textContent = list.length || '';
  if (!list.length) {
    el('rows').innerHTML = emptyHtml(q || state.group !== 'all' ? 'noMatch' : 'noConnections', q || state.group !== 'all' ? 'noMatchHint' : 'noConnectionsHint');
    renderPager(0, 0, state.pageSize, (p) => { state.page = p; renderConnections(state.query.trim().toLowerCase()); });
    return;
  }
  el('rows').innerHTML = `<div class="rows">${slice.items.map(rowHtml).join('')}</div>`;
  renderPager(list.length, slice.p, state.pageSize, (p) => { state.page = p; renderConnections(state.query.trim().toLowerCase()); });
}

function rowHtml(item) {
  const r = readinessOf(item);
  const st = stateLabelFor(r);
  const diag = item.diagnostic;
  const expiring = item.credential?.expiringSoon && !item.credential?.expired;
  const expired = item.credential?.expired;
  let note = '';
  let noteClass = '';
  if (r === 'credential-invalid') { note = `${t('businessInvalid')} — ${t('hintReauth')}`; noteClass = 'bad'; }
  else if (expired) { note = t('credentialExpired'); noteClass = 'bad'; }
  else if (expiring) { note = t('credentialExpiring'); noteClass = 'warn'; }
  /* 已验证是默认状态：状态药丸已经说了，不再重复一行备注。 */
  else if (r === 'unknown') { note = diag?.message ? esc(diag.message) : t('businessUnknown'); noteClass = 'warn'; }
  else if (diag?.message) { note = esc(diag.message); }

  const canRepair = item.authMode === 'bearer' || item.authMode === 'api-key';
  const actions = [];
  if (r === 'credential-invalid' && canRepair) actions.push(`<button class="tbtn fix" data-act="repair" data-key="${esc(item.key)}" data-mode="${esc(item.authMode)}">${t('repair')}</button>`);
  actions.push(`<button class="tbtn" data-act="recheck" data-key="${esc(item.key)}">${t('recheck')}</button>`);
  actions.push(`<button class="tbtn" data-act="${item.enabled === false ? 'enable' : 'disable'}" data-key="${esc(item.key)}">${item.enabled === false ? t('enable') : t('disable')}</button>`);
  actions.push(`<button class="tbtn danger" data-act="disconnect" data-key="${esc(item.key)}">${t('disconnect')}</button>`);

  return `<article class="row" data-readiness="${r}" data-state="${esc(item.connectionState)}">
    <span class="status-dot" aria-hidden="true"></span>
    <div>
      <div class="row-title">
        <strong>${esc(item.name)}</strong>
        <span class="chip">${esc(item.serverName)}</span>
        <span class="state-label ${st.cls}">${st.text}</span>
        ${expired || expiring ? `<span class="state-label ${expired ? 'bad' : 'warn'}">${expired ? t('credentialExpired') : t('credentialExpiring')}</span>` : ''}
      </div>
      <div class="row-meta">
        <span>${esc(authLabel(item))}</span>
        ${item.transport ? `<span>${esc(item.transport)}</span>` : ''}
        <span>${scopeLabel(item)}</span>
        <span class="endpoint" title="${esc(item.endpoint)}">${esc(item.endpoint)}</span>
      </div>
      ${note ? `<div class="row-note ${noteClass}">${note}</div>` : ''}
    </div>
    <div class="row-actions">${actions.join('')}</div>
  </article>`;
}

/* ── 目录：分组 + 分页 ───────────────────────────────── */
function renderCatalog(q) {
  let list = state.catalog.filter((c) => !q || [c.name, c.id, c.vendor, c.summary, c.category].some((v) => String(v ?? '').toLowerCase().includes(q)));
  if (state.group !== 'all') list = list.filter((c) => (CATEGORY_GROUP[c.category] ?? 'other') === state.group);

  const slice = pageSlice(list, state.page, state.pageSize);
  state.page = slice.p;
  el('list-title').textContent = state.group === 'all' ? t('catalog') : groupLabel(state.group);
  el('list-count').textContent = list.length || '';
  if (!list.length) {
    el('rows').innerHTML = emptyHtml(q || state.group !== 'all' ? 'noMatch' : 'noCatalog', q || state.group !== 'all' ? 'noMatchHint' : 'noCatalogHint');
    renderPager(0, 0, state.pageSize, (p) => { state.page = p; renderCatalog(state.query.trim().toLowerCase()); });
    return;
  }
  el('rows').innerHTML = `<div class="grid">${slice.items.map(cardHtml).join('')}</div>`;
  renderPager(list.length, slice.p, state.pageSize, (p) => { state.page = p; renderCatalog(state.query.trim().toLowerCase()); });
}

function cardHtml(c) {
  const connected = (c.connected?.length ?? 0) > 0;
  const initial = esc(String(c.name || c.id || '?').trim().charAt(0).toUpperCase());
  return `<article class="tile">
    <div class="tile-icon">${initial}</div>
    <div>
      <div class="tile-name">${esc(c.name)} <span class="chip">${esc(c.id)}</span></div>
      <div class="tile-vendor">${esc(c.vendor || '')}</div>
      <div class="tile-desc">${esc(c.summary || '')}</div>
      <div class="tile-tags"><span>${esc(c.category || '')}</span><span>${esc(authLabel({ authMode: c.authMode }))}</span>${connected ? `<span style="color:var(--ok)">●</span>` : ''}</div>
    </div>
    <div class="tile-foot">
      <button class="tbtn ${connected ? '' : 'strong'}" data-act="connect" data-id="${esc(c.id)}">${connected ? t('detail') : t('connect')}</button>
    </div>
  </article>`;
}

/* ── 工具：服务端搜索 + 筛选 + 分页 ──────────────────── */
function syncToolFilters() {
  const servers = [...new Set((state.tools?.connections ?? []).map((c) => c.serverName).filter(Boolean))].sort();
  const serverSel = el('tool-server-filter');
  const statusSel = el('tool-status-filter');
  const signature = servers.join('\u0000');
  // 只在服务列表变化时重建，避免筛选过程中把用户刚选中的值冲掉。
  if (serverSel._signature !== signature) {
    serverSel.innerHTML = `<option value="">${t('allServers')}</option>` + servers.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    serverSel._signature = signature;
  }
  if (!statusSel.options.length) {
    statusSel.innerHTML = `<option value="">${t('allStatus')}</option>`
      + `<option value="success">${t('statusSuccess')}</option>`
      + `<option value="failed">${t('statusFailed')}</option>`
      + `<option value="unknown">${t('statusUnknown')}</option>`
      + `<option value="pending">${t('statusPending')}</option>`;
  }
  serverSel.value = state.toolServer;
  statusSel.value = state.toolStatus;
  el('tool-search').value = state.toolQuery;
  el('tool-search').placeholder = t('toolSearch');
  const total = state.tools?.total ?? 0;
  el('tool-hint').textContent = t('toolCount', { count: total });
}

function renderToolView() {
  const detail = state.tools;
  const items = detail?.items ?? [];
  el('list-title').textContent = t('tools');
  el('list-count').textContent = detail?.total ?? '';
  if (!items.length) {
    el('rows').innerHTML = emptyHtml(state.toolQuery || state.toolServer || state.toolStatus ? 'noMatch' : 'noTools',
      state.toolQuery || state.toolServer || state.toolStatus ? 'noMatchHint' : 'noToolsHint');
    renderPager(0, 0, state.toolPageSize, () => {});
    return;
  }
  const groups = new Map();
  for (const tool of items) {
    const key = tool.serverName || tool.connectionKey || 'server';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tool);
  }
  el('rows').innerHTML = [...groups.entries()].map(([server, tools]) => `
    <section class="tool-server">
      <h4>${esc(server)} <span class="n">${tools.length}</span></h4>
      <div>${tools.map((tool) => `
        <div class="tool-row"><span class="name" title="${esc(tool.name)}">${esc(tool.name)}</span><span class="desc">${esc(tool.title || tool.description || '')}</span></div>
      `).join('')}</div>
    </section>`).join('');
  renderPager(detail?.total ?? 0, state.toolPage, state.toolPageSize, (p) => { state.toolPage = p; loadTools().then(renderToolView); });
}

/* ── 交互 ───────────────────────────────────────────── */
async function onAction(act, target) {
  const key = target.dataset.key;
  if (act === 'repair') return openRepair(key, target.dataset.mode);
  if (act === 'recheck') { toast(t('checkedOk')); return loadAll({ deepCheck: true }); }
  if (act === 'enable' || act === 'disable') {
    const res = await call('setEnabled', { key, enabled: act === 'enable' });
    toast(res.message);
    return loadAll();
  }
  if (act === 'disconnect') {
    if (!confirm(t('confirmDisconnect'))) return;
    const res = await call('disconnect', { key });
    toast(res.message);
    return loadAll();
  }
  if (act === 'connect') {
    const res = await call('connect', { connectorId: target.dataset.id });
    toast(res.message);
    if (res.ok) return loadAll({ deepCheck: true });
    // OAuth 缺 DCR（或 DCR 被拒）：让用户补自己登记的 client_id / secret，而不是干瞪眼。
    if (res.detail?.recoverable === 'provide-oauth-client') {
      return openOAuthClientDialog(target.dataset.id);
    }
    if (/凭据|credential|api.?key|token/i.test(res.message || '')) return openRepair('', res.detail?.authMode || 'bearer', res.detail);
  }
  if (act === 'reuse-cli') {
    const res = await call('reuseCliAuth', { connectorId: target.dataset.id });
    toast(res.message);
    return loadAll({ deepCheck: true });
  }
}

/**
 * OAuth 客户端补充对话框。
 *
 * 用于服务端**没有** DCR 的场景：用户需要把在自己服务里登记过的 OAuth App
 * 的 client_id（必要时 secret）填进来，随后仍走标准浏览器授权。
 * 这里只把值原样交给 Host，不在前端保存、不回显。
 */
function openOAuthClientDialog(connectorId) {
  const mask = el('mask');
  mask.innerHTML = `<div class="dialog" role="dialog" aria-modal="true">
    <h2>${esc(t('oauthClientTitle'))}</h2>
    <p>${esc(t('oauthClientHint'))}</p>
    <div class="field"><label>${esc(t('oauthClientId'))}</label>
      <input id="oauth-client-id" class="mono" autocomplete="off" placeholder="Iv1.xxxxxxxxxxxx"></div>
    <div class="field"><label>${esc(t('oauthClientSecret'))}</label>
      <input type="password" id="oauth-client-secret" class="mono" autocomplete="off" placeholder="（机密客户端才需要）"></div>
    <div class="field"><label>${esc(t('oauthFlow'))}</label>
      <select id="oauth-flow">
        <option value="">${esc(t('flowAuto'))}</option>
        <option value="authorization-code">${esc(t('flowCode'))}</option>
        <option value="device-code">${esc(t('flowDevice'))}</option>
      </select></div>
    <div class="field"><div class="help" id="oauth-client-help"></div></div>
    <div class="dialog-actions">
      <button class="tbtn" data-dlg="cancel">${esc(t('cancel'))}</button>
      <button class="tbtn strong" data-dlg="oauth-save">${esc(t('connect'))}</button>
    </div>
  </div>`;
  mask.hidden = false;
  mask._ctx = { kind: 'oauth-client', connectorId };
  setTimeout(() => el('oauth-client-id')?.focus(), 0);
}

async function submitOAuthClient() {
  const mask = el('mask');
  const ctx = mask._ctx;
  const clientId = el('oauth-client-id')?.value?.trim();
  const clientSecret = el('oauth-client-secret')?.value?.trim();
  const flow = el('oauth-flow')?.value?.trim();
  const help = el('oauth-client-help');
  if (!clientId) { help.textContent = t('oauthClientId'); return; }
  help.textContent = '';
  const btn = mask.querySelector('[data-dlg="oauth-save"]');
  btn.disabled = true;
  try {
    const res = await call('connect', {
      connectorId: ctx.connectorId,
      oauthClient: { clientId, ...(clientSecret ? { clientSecret } : {}) },
      ...(flow ? { oauthFlow: flow } : {}),
    });
    toast(res.message);
    if (res.ok) { closeDialog(); await loadAll({ deepCheck: true }); }
    else help.textContent = res.message || '';
  } finally { btn.disabled = false; }
}

function openRepair(key, mode, connectDetail) {
  const mask = el('mask');
  const isBearer = mode !== 'api-key';
  const title = connectDetail ? t('connect') : t('repairTitle');
  const hint = connectDetail ? (connectDetail.credentialDescription || t('repairHint')) : t('repairHint');
  const guide = connectDetail?.credentialGuide;
  const cliProviders = Array.isArray(connectDetail?.cliAuthProviders) ? connectDetail.cliAuthProviders : [];
  mask.innerHTML = `<div class="dialog" role="dialog" aria-modal="true">
    <h2>${esc(title)}</h2>
    <p>${esc(hint)}</p>
    ${connectDetail ? `<div class="field"><label>连接器</label><input class="mono" value="${esc(connectDetail.connectorId || connectDetail.id || '')}" disabled></div>` : ''}
    ${guide?.url ? `<div class="field">
      <label>${esc(t('whereToGet'))}</label>
      <div class="help"><a href="${esc(guide.url)}" target="_blank" rel="noopener noreferrer">${esc(guide.label || t('openGuide'))}</a>
      ${guide.note ? `<div style="margin-top:4px;opacity:.75">${esc(guide.note)}</div>` : ''}</div>
    </div>` : ''}
    ${cliProviders.length ? `<div class="field">
      <div class="help">${esc(t('reuseCliHint', { labels: cliProviders.join(', ') }))}</div>
    </div>` : ''}
    <div class="field">
      <label>${isBearer ? t('newToken') : t('newKey')}</label>
      <input type="password" id="repair-value" class="mono" autocomplete="off" placeholder="${isBearer ? 'API Token' : 'API Key'}">
    </div>
    ${isBearer ? '' : `<div class="field"><label>${t('keyHeader')}</label><input id="repair-header" class="mono" placeholder="X-Api-Key"></div>`}
    <div class="field"><div class="help" id="repair-help"></div></div>
    <div class="dialog-actions">
      <button class="tbtn" data-dlg="cancel">${t('cancel')}</button>
      ${cliProviders.length ? `<button class="tbtn" data-dlg="reuse-cli">${esc(t('reuseCli'))}</button>` : ''}
      <button class="tbtn strong" data-dlg="save">${t('save')}</button>
    </div>
  </div>`;
  mask.hidden = false;
  mask._ctx = { key, mode, connectDetail };
  setTimeout(() => el('repair-value')?.focus(), 0);
}

async function submitRepair() {
  const ctx = el('mask')._ctx;
  const value = el('repair-value')?.value?.trim();
  const help = el('repair-help');
  if (!value) { help.textContent = ctx.mode === 'api-key' ? t('newKey') : t('newToken'); return; }
  help.textContent = '';
  const btn = el('mask').querySelector('[data-dlg="save"]');
  btn.disabled = true;
  try {
    let res;
    if (ctx.connectDetail || !ctx.key) {
      const id = ctx.connectDetail?.connectorId || ctx.connectDetail?.id;
      res = await call('configure', { connectorId: id, bearerToken: value, apiKeyValue: value });
    } else {
      res = await call('repairCredentials', {
        key: ctx.key,
        ...(ctx.mode === 'api-key'
          ? { apiKeyValue: value, apiKeyHeader: el('repair-header')?.value?.trim() || undefined }
          : { bearerToken: value }),
      });
    }
    toast(res.message);
    if (res.ok) { closeDialog(); await loadAll({ deepCheck: true }); }
    else help.textContent = res.message || '';
  } finally { btn.disabled = false; }
}

function closeDialog() { el('mask').hidden = true; el('mask')._ctx = null; }

function openAdd() {
  const mask = el('mask');
  mask.innerHTML = `<div class="dialog" role="dialog" aria-modal="true">
    <h2>${t('add')}</h2>
    <p>粘贴 MCP 连接配置 JSON（{ "mcpServers": { … } }），或填写连接器描述 URL。</p>
    <div class="field"><label>JSON 配置</label><textarea id="add-json" rows="6" class="mono" placeholder='{ "mcpServers": { "name": { "url": "https://…" } } }'></textarea></div>
    <div class="field"><label>或：描述文件 URL</label><input id="add-url" class="mono" placeholder="https://…/dsh-connector.json"></div>
    <div class="field"><div class="help" id="add-help"></div></div>
    <div class="dialog-actions">
      <button class="tbtn" data-dlg="cancel">${t('cancel')}</button>
      <button class="tbtn strong" data-dlg="add-save">${t('save')}</button>
    </div>
  </div>`;
  mask.hidden = false;
  setTimeout(() => el('add-json')?.focus(), 0);
}

async function submitAdd() {
  const json = el('add-json')?.value?.trim();
  const url = el('add-url')?.value?.trim();
  const help = el('add-help');
  if (!json && !url) { help.textContent = '请填写 JSON 或 URL'; return; }
  const btn = el('mask').querySelector('[data-dlg="add-save"]');
  btn.disabled = true;
  try {
    const res = json ? await call('importJson', { json }) : await call('installFromUrl', { url });
    toast(res.message);
    if (res.ok) { closeDialog(); await loadAll({ deepCheck: true }); }
    else help.textContent = res.message || '';
  } finally { btn.disabled = false; }
}

/* ── 宿主字体同步 ─────────────────────────────────────
 * DSH 把用户在「设置 → 字体」里选的字族/字号写在父页面 body.style 上
 * （--dsh-font-family-text / --dsh-font-family-code / --dsh-content-font-size）。
 * CSS 变量不跨 iframe 继承，所以由父页面 postMessage 过来，这里写到 :root。
 * 值只接受字符串且做长度限制，避免异常输入撑爆样式。
 */
function applyHostFonts(fonts) {
  if (!fonts || typeof fonts !== 'object') return;
  const root = document.documentElement;
  const setFamily = (cssVar, value) => {
    if (typeof value !== 'string') return;
    const v = value.trim().slice(0, 400);
    // 字族带引号或逗号时原样写入即可；空串表示「用户没自定义」，移除后回退内置栈。
    if (!v) root.style.removeProperty(cssVar);
    else root.style.setProperty(cssVar, v);
  };
  const setSize = (cssVar, value) => {
    // 同时接受 16 与 "16px"：Host 注入的是数字，而 postMessage 读回来的是
    // body.style 里的字符串（带 px），两种形态都要认。
    const raw = typeof value === 'string' ? value.trim().replace(/px$/i, '') : value;
    const n = Number(raw);
    if (raw === '' || raw === undefined || raw === null || !Number.isFinite(n) || n <= 0 || n >= 100) {
      root.style.removeProperty(cssVar);
      return;
    }
    root.style.setProperty(cssVar, `${n}px`);
  };
  setFamily('--dsh-font-family-text', fonts.text);
  setFamily('--dsh-font-family-code', fonts.code);
  setFamily('--dsh-font-family-terminal', fonts.terminal);
  setSize('--dsh-content-font-size', fonts.contentSize);
  setSize('--dsh-code-font-size', fonts.codeSize);
  setSize('--dsh-terminal-font-size', fonts.terminalSize);
}


/* ── 事件绑定 ───────────────────────────────────────── */
function bind() {
  document.querySelectorAll('.nav button').forEach((btn) => btn.addEventListener('click', async () => {
    state.view = btn.dataset.view;
    state.page = 0;
    state.toolPage = 0;
    if (state.view === 'tools' && !state.tools) await loadTools();
    render();
  }));

  el('search').addEventListener('input', (e) => { state.query = e.target.value; state.page = 0; render(); });
  el('btn-refresh').addEventListener('click', () => loadAll());
  el('btn-check').addEventListener('click', () => loadAll({ deepCheck: true }));
  el('btn-add').addEventListener('click', openAdd);
  el('probe-toggle').addEventListener('change', (e) => {
    if (e.target.checked) loadAll({ deepCheck: true });
  });

  // 分组切换
  el('groupbar').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-group]');
    if (!btn) return;
    state.group = btn.dataset.group;
    state.page = 0;
    render();
  });

  // 分页
  el('pager').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-page]');
    if (!btn || btn.disabled || !el('pager')._onPage) return;
    const delta = btn.dataset.page === 'prev' ? -1 : 1;
    const cur = state.view === 'tools' ? state.toolPage : state.page;
    el('pager')._onPage(Math.max(0, cur + delta));
  });

  // 工具筛选：输入防抖后走服务端查询
  let toolTimer;
  el('tool-search').addEventListener('input', (e) => {
    state.toolQuery = e.target.value;
    state.toolPage = 0;
    clearTimeout(toolTimer);
    toolTimer = setTimeout(() => loadTools().then(render), 250);
  });
  el('tool-server-filter').addEventListener('change', (e) => {
    state.toolServer = e.target.value;
    state.toolPage = 0;
    loadTools().then(render);
  });
  el('tool-status-filter').addEventListener('change', (e) => {
    state.toolStatus = e.target.value;
    state.toolPage = 0;
    loadTools().then(render);
  });

  el('content').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (btn) onAction(btn.dataset.act, btn);
  });
  el('mask').addEventListener('click', (e) => {
    if (e.target === el('mask')) return closeDialog();
    const act = e.target.closest('[data-dlg]')?.dataset.dlg;
    if (act === 'cancel') closeDialog();
    else if (act === 'save') submitRepair();
    else if (act === 'oauth-save') submitOAuthClient();
    else if (act === 'reuse-cli') {
      const ctx = el('mask')._ctx;
      const connectorId = ctx?.connectDetail?.connectorId || ctx?.connectDetail?.id;
      if (!connectorId) return;
      el('mask').querySelector('[data-dlg="reuse-cli"]').disabled = true;
      call('reuseCliAuth', { connectorId }).then(async (res) => {
        toast(res.message);
        if (res.ok) { closeDialog(); await loadAll({ deepCheck: true }); }
        else { const help = el('repair-help'); if (help) help.textContent = res.message || ''; }
      });
    }
    else if (act === 'add-save') submitAdd();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el('mask').hidden) closeDialog(); });

  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin || !event.data || typeof event.data !== 'object') return;
    if (event.data.type === 'connector-hub:workspace-context') {
      const ws = event.data.workspace;
      state.workspaceId = ws?.workspaceId ? String(ws.workspaceId) : '';
      state.workspaces = Array.isArray(event.data.workspaces) ? event.data.workspaces : [];
      loadAll();
      return;
    }
    if (event.data.type === 'connector-hub:theme-fonts') {
      applyHostFonts(event.data.fonts);
    }
  });
  try { window.parent?.postMessage?.({ type: 'connector-hub:workspace-context-request' }, window.location.origin); } catch { /* 独立打开时忽略 */ }
  // 字体单独请求一次：工作区上下文可能先到，字体不应被它拖慢。
  try { window.parent?.postMessage?.({ type: 'connector-hub:theme-fonts-request' }, window.location.origin); } catch { /* 独立打开时忽略 */ }

  let es;
  let refreshTimer;
  const scheduleRefresh = () => {
    if (document.hidden) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => loadAll(), 150);
  };
  try {
    es = new EventSource(EVENTS);
    es.addEventListener('ready', scheduleRefresh);
    es.addEventListener('status', scheduleRefresh);
  } catch { /* 无 SSE 时靠手动刷新 */ }
  window.addEventListener('pagehide', () => es?.close());
}

function applyStaticText() {
  document.title = `${t('brand')} · ${t('subtitle')}`;
  el('brand-name').textContent = t('brand');
  el('brand-sub').textContent = t('subtitle');
  el('nav-connections-label').textContent = t('connections');
  el('nav-catalog-label').textContent = t('catalog');
  el('nav-tools-label').textContent = t('tools');
  el('search').placeholder = t('search');
  el('btn-refresh').textContent = t('refresh');
  el('btn-check').textContent = t('check');
  el('btn-add').textContent = t('add');
  el('overview-title').textContent = t('overview');
  el('overview-sub').textContent = t('overviewSub');
  el('nav-label').textContent = t('workspace');
  el('legend-ok').textContent = t('verified');
  el('legend-warn').textContent = t('unknown');
  el('legend-bad').textContent = t('invalid');
  el('legend-idle').textContent = t('idle');
  el('stat-ok-label').textContent = t('verified');
  el('stat-warn-label').textContent = t('unknown');
  el('stat-bad-label').textContent = t('invalid');
  el('probe-label').textContent = t('deepProbe');
  el('probe-note').textContent = t('deepProbeNote');
  el('tool-search').placeholder = t('toolSearch');
}

// 先应用 Host 注入的字体（服务端已读好宿主配置），保证首帧就是正确字体；
// 后续 postMessage 只用于用户当场改字体时的实时更新。
try { applyHostFonts(window.__CONNECTOR_HUB_FONTS__); } catch { /* 独立打开时无注入 */ }

applyStaticText();
bind();
// 首次进入自动跑一次深度检查：面板的默认动作就是「让连接状态变真」。
loadAll().then(() => {
  if (state.items.some((item) => item.enabled !== false)) loadAll({ deepCheck: true });
});
