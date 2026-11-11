/* 连接器 — 面板逻辑 v5（极简）
 *
 * 契约：POST /connector-hub/api  {method, params}；GET /connector-hub/events（SSE）。
 * 业务失败 = HTTP 200 + {ok:false, message}。所有状态枚举按值判断，文案只展示不解析。
 *
 * v5 相比 v4 做的减法：
 *   - 只有「目录」一个视图；工具视图、左侧导航、健康检查全部移除。
 *   - 已连接的应用收进右上角抽屉，点开才渲染。
 *   - 永不调用 healthCheck（那个接口要握手甚至跑探针，是卡顿根因）。
 * 本文件不读取、不回显任何凭据；修复凭据时只把用户新输入的值发给 repairCredentials。
 */

const API = '/connector-hub/api';
const EVENTS = '/connector-hub/events';

const TIMEOUTS = {
  connect: 145000, configure: 145000, importJson: 145000, installFromUrl: 145000,
  repairCredentials: 145000, reconfigureConnection: 145000, restoreSnapshot: 145000,
  setEnabled: 130000, catalog: 20000, status: 20000, _default: 30000,
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
  catalog: [],        // catalog.detail.items（compact）
  items: [],          // status.detail.items（已连接的实例）
  query: '',
  group: 'all',
  page: 0,
  pageSize: 12,
  loading: false,
  busy: false,
  workspaceId: '',
  // 布局记在 localStorage，刷新面板后保持用户选择；沙箱里不可用时静默回退。
  layout: (() => { try { return localStorage.getItem('connector-hub:layout') === 'grid' ? 'grid' : 'list'; } catch { return 'list'; } })(),
  loaded: false,          // 是否已拿到过首屏数据（只在第一次显示 loading）
  refreshPending: false,  // 加载中又收到刷新信号时，结束后补跑一次
  drawerOpen: false,
};

/* 首屏快照缓存：面板是 iframe，反复开关很常见。有快照就先立刻渲染，
   再在后台静默刷新，避免每次进来都对着空白等网络。键含 workspaceId 以免串台。 */
const SNAPSHOT_KEY = 'connector-hub:snapshot';
function readSnapshot() {
  try {
    const raw = sessionStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw);
    if (!snap || !Array.isArray(snap.items) || !Array.isArray(snap.catalog)) return null;
    return snap;
  } catch { return null; }
}
function writeSnapshot() {
  try {
    sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify({
      workspaceId: state.workspaceId, items: state.items, catalog: state.catalog,
    }));
  } catch { /* 沙箱或配额忽略 */ }
}

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
    brand: '连接器', subtitle: '外部服务接入', catalog: '目录',
    search: '搜索连接器…', refresh: '刷新', add: '添加连接',
    checkUpdate: '检查更新', checkingUpdate: '正在检查…', updateFailed: '检查失败，请稍后重试，或打开 GitHub 发行页。',
    updateVersions: '当前 v{current} · 最新 v{latest} · {status}', updateAvailable: '发现新版', updateCurrent: '已是最新版本', updateAhead: '当前版本较新',
    downloadUpdate: '下载安装包', updateReleases: '查看发行页',
    connected: '已连接', connectedTitle: '已连接的应用', close: '关闭',
    connectedEmpty: '还没有连接任何应用', connectedEmptyHint: '在上方目录里挑一个，点「连接」即可。',
    noCatalog: '目录为空', noCatalogHint: '检查网络，或点「刷新」重新拉取目录。',
    noMatch: '没有匹配的内容', noMatchHint: '换一个关键词，或清除筛选条件。',
    repair: '修复凭据', repairTitle: '更新凭据',
    repairHint: '只替换 Token / API Key，URL、作用域、注入模式等其余配置保持不变。',
    newToken: '新的 API Token', newKey: '新的 API Key', keyHeader: '头名（可选）',
    save: '保存', cancel: '取消', connect: '连接', disconnect: '断开',
    enable: '启用', disable: '停用', detail: '已连接',
    repaired: '凭据已更新',
    authBearer: 'Bearer Token', authApiKey: 'API Key', authOAuth: 'OAuth', authNone: '无需凭据',
    global: '全局', scopeProject: '项目',
    credentialExpiring: '凭据即将过期', credentialExpired: '凭据已过期',
    businessUnknown: '待确认',
    businessInvalid: '凭据已失效：握手正常，但真实调用被拒绝',
    layoutList: '列表视图', layoutGrid: '栅格视图',
    hintReauth: '点「修复凭据」填入新 Token，或重新授权。',
    confirmDisconnect: '确定断开这条连接吗？',
    prev: '上一页', next: '下一页', pageInfo: '第 {from}–{to} 条，共 {total} 条',
    whereToGet: '去哪里获取凭据', openGuide: '打开申请页面',
    reuseCli: '复用本机已登录凭据', reuseCliHint: '检测到本机 {labels} 已登录，可直接复用其授权，无需手工创建 Token。',
    oauthClientTitle: '此服务不支持自动注册客户端',
    oauthClientHint: '该服务的 OAuth 未提供动态客户端注册（DCR）。请填写你在该服务登记的 OAuth App 的 client_id（机密客户端还需 client_secret），之后就能用浏览器正常登录。',
    oauthClientId: 'OAuth Client ID', oauthClientSecret: 'OAuth Client Secret（可选）',
    oauthFlow: '授权方式', flowAuto: '自动', flowCode: '浏览器授权码', flowDevice: '设备码（输入短码）',
    statConnected: '在连', statProblem: '异常',
  },
  en: {
    brand: 'Connector', subtitle: 'External service access', catalog: 'Catalog',
    search: 'Search connectors…', refresh: 'Refresh', add: 'Add connection',
    checkUpdate: 'Check for updates', checkingUpdate: 'Checking…', updateFailed: 'Could not check for updates. Try again or open GitHub Releases.',
    updateVersions: 'Current v{current} · Latest v{latest} · {status}', updateAvailable: 'Update available', updateCurrent: 'Up to date', updateAhead: 'Local version is newer',
    downloadUpdate: 'Download package', updateReleases: 'View releases',
    connected: 'Connected', connectedTitle: 'Connected apps', close: 'Close',
    connectedEmpty: 'Nothing connected yet', connectedEmptyHint: 'Pick one from the catalog above and hit Connect.',
    noCatalog: 'Catalog is empty', noCatalogHint: 'Check the network, or press Refresh to reload.',
    noMatch: 'Nothing matches', noMatchHint: 'Try another keyword, or clear the filters.',
    repair: 'Fix credentials', repairTitle: 'Update credentials',
    repairHint: 'Only the token / API key is replaced; URL, scope and injection mode stay unchanged.',
    newToken: 'New API token', newKey: 'New API key', keyHeader: 'Header name (optional)',
    save: 'Save', cancel: 'Cancel', connect: 'Connect', disconnect: 'Disconnect',
    enable: 'Enable', disable: 'Disable', detail: 'Connected',
    repaired: 'Credentials updated',
    authBearer: 'Bearer Token', authApiKey: 'API Key', authOAuth: 'OAuth', authNone: 'No credential',
    global: 'Global', scopeProject: 'Project',
    credentialExpiring: 'Credential expiring soon', credentialExpired: 'Credential expired',
    businessUnknown: 'Unconfirmed',
    businessInvalid: 'Credential invalid: handshake succeeded but real calls are rejected',
    layoutList: 'List view', layoutGrid: 'Grid view',
    hintReauth: 'Click Fix credentials to enter a new token, or reauthorize.',
    confirmDisconnect: 'Disconnect this connection?',
    prev: 'Previous', next: 'Next', pageInfo: '{from}–{to} of {total}',
    whereToGet: 'Where to get credentials', openGuide: 'Open signup page',
    reuseCli: 'Reuse local CLI login', reuseCliHint: 'Detected a logged-in {labels} on this machine; its authorization can be reused instead of creating a token manually.',
    oauthClientTitle: 'This service does not support automatic client registration',
    oauthClientHint: 'This OAuth server does not offer Dynamic Client Registration (DCR). Enter the client_id of the OAuth App you registered with the service (plus client_secret for confidential clients) and browser sign-in will work.',
    oauthClientId: 'OAuth Client ID', oauthClientSecret: 'OAuth Client Secret (optional)',
    oauthFlow: 'Authorization flow', flowAuto: 'Auto', flowCode: 'Browser authorization code', flowDevice: 'Device code (enter a short code)',
    statConnected: 'Active', statProblem: 'Issues',
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
  node.dataset.kind = kind;
  clearTimeout(node._timer);
  node._timer = setTimeout(() => { node.hidden = true; }, 4200);
}

/* ── 数据加载 ───────────────────────────────────────── */
/**
 * 只取「状态 + 目录」，永远不碰 healthCheck。
 * healthCheck 即使轻量也要握手甚至跑探针（实测 8s+），把它放进首屏路径就是这个面板卡顿的根因。
 * 目录走 compact 模式（后端砍掉 prompts/servers 等大字段，313KB → ~18KB）。
 */
async function loadAll() {
  if (state.busy) { state.refreshPending = true; return; }
  state.busy = true;
  if (!state.loaded) setLoading(true);
  try {
    const workspaceParams = state.workspaceId ? { workspaceId: state.workspaceId } : {};
    const [statusRes, catalogRes] = await Promise.all([
      call('status', workspaceParams),
      call('catalog', { ...workspaceParams, compact: true }),
    ]);
    if (statusRes.ok) state.items = statusRes.detail?.items ?? [];
    else toast(statusRes.message, 'bad');
    if (catalogRes.ok) state.catalog = catalogRes.detail?.items ?? [];
    state.loaded = true;
    writeSnapshot();
    render();
  } finally {
    state.busy = false;
    setLoading(false);
    if (state.refreshPending) { state.refreshPending = false; loadAll(); }
  }
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
  return { cls, text: t(r === 'verified' ? 'detail' : r === 'credential-invalid' ? 'invalid' : r === 'idle' ? 'idle' : 'businessUnknown') };
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

/** 某条连接实例对应的目录项 category（用于分组） */
function catalogCategoryOf(id) { return state.catalog.find((c) => c.id === id)?.category ?? ''; }

/* ── 渲染总入口 ─────────────────────────────────────── */
function render() {
  const connectedCount = state.items.filter((i) => i.enabled !== false).length;
  el('connected-count').textContent = connectedCount || '';
  el('list-count').textContent = state.catalog.length || '';
  const layoutSwitch = el('layout-switch');
  if (layoutSwitch) {
    layoutSwitch.querySelectorAll('[data-layout]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.layout === state.layout)));
  }
  renderGroupBar();
  renderCatalog(state.query.trim().toLowerCase());
  if (state.drawerOpen) renderDrawer();
}

/** 分组条：按当前数据统计每个分组的数量，只显示非空组。 */
function renderGroupBar() {
  const q = state.query.trim().toLowerCase();
  const counts = new Map();
  for (const c of state.catalog) {
    if (q && ![c.name, c.id, c.vendor, c.summary, c.category].some((v) => String(v ?? '').toLowerCase().includes(q))) continue;
    const g = CATEGORY_GROUP[c.category] ?? 'other';
    counts.set(g, (counts.get(g) ?? 0) + 1);
    counts.set('all', (counts.get('all') ?? 0) + 1);
  }
  const keys = GROUP_KEYS.filter((k) => k === 'all' || counts.has(k));
  // 当前选中组没有数据时回落到全部
  if (!keys.includes(state.group)) state.group = 'all';
  el('groupbar').innerHTML = counts.size
    ? keys.map((k) => `<button type="button" data-group="${k}" aria-pressed="${state.group === k}">${groupLabel(k)}<span class="n">${counts.get(k) ?? 0}</span></button>`).join('')
    : '';
  el('groupbar').hidden = !counts.size;
}

/** 通用分页渲染。 */
function renderPager(total, page, pageSize, onPage) {
  const pager = el('pager');
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) { pager.hidden = true; pager.innerHTML = ''; pager._onPage = null; return; }
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
  // 数据变少时把页码收回到最后一页，调用方会写回 state.page。
  const p = Math.min(Math.max(0, page), pages - 1);
  return { p, items: list.slice(p * pageSize, p * pageSize + pageSize) };
}

function emptyHtml(titleKey, hintKey) {
  return `<div class="empty"><strong>${t(titleKey)}</strong>${t(hintKey)}</div>`;
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
    renderPager(0, 0, state.pageSize, () => {});
    return;
  }
  const gridClass = state.layout === 'grid' ? 'grid grid-cards' : 'grid grid-list';
  el('rows').innerHTML = `<div class="${gridClass}">${slice.items.map((c) => cardHtml(c, state.layout)).join('')}</div>`;
  renderPager(list.length, slice.p, state.pageSize, (p) => { state.page = p; renderCatalog(state.query.trim().toLowerCase()); });
}

function cardHtml(c, layout = 'list') {
  const connected = (c.connected?.length ?? 0) > 0;
  // 图标优先用目录自带 icon（URL/emoji/图标名），否则按 id / 类目挑线性矢量图标；
  // icons.js 未加载时退回首字母，保证不会开天窗。
  const icon = window.ConnectorIcons?.iconHtml
    ? window.ConnectorIcons.iconHtml(c, layout === 'grid' ? 20 : 18)
    : `<span class="ci-emoji">${esc(String(c.name || c.id || '?').trim().charAt(0).toUpperCase())}</span>`;
  const meta = `<span>${esc(c.category || '')}</span><span>${esc(authLabel({ authMode: c.authMode }))}</span>`;
  const foot = `<div class="tile-foot"><button class="tbtn ${connected ? '' : 'strong'}" data-act="connect" data-id="${esc(c.id)}">${connected ? t('detail') : t('connect')}</button></div>`;
  if (layout === 'grid') {
    return `<article class="tile"${connected ? ' data-connected="1"' : ''}>
      <div class="tile-icon">${icon}</div>
      <div>
        <div class="tile-name">${esc(c.name)} <span class="chip">${esc(c.id)}</span></div>
        <div class="tile-vendor">${esc(c.vendor || '')}</div>
        <div class="tile-desc">${esc(c.summary || '')}</div>
        <div class="tile-tags">${meta}</div>
      </div>
      ${foot}
    </article>`;
  }
  // 列表视图精简列：图标 + 名称/ID + 一行简介 + 分类·鉴权 + 操作，去掉厂商独立行。
  return `<article class="tile"${connected ? ' data-connected="1"' : ''}>
    <div class="tile-icon">${icon}</div>
    <div>
      <div class="tile-name">${esc(c.name)} <span class="chip">${esc(c.id)}</span>${connected ? '<span class="dot-ok" aria-hidden="true"></span>' : ''}</div>
      <div class="tile-desc tile-desc-clamp">${esc(c.summary || '')}</div>
      <div class="tile-tags">${meta}</div>
    </div>
    ${foot}
  </article>`;
}

/* ── 已连接抽屉 ─────────────────────────────────────── */
function openDrawer() {
  state.drawerOpen = true;
  el('scrim').hidden = false;
  el('drawer').hidden = false;
  el('btn-connected').setAttribute('aria-expanded', 'true');
  renderDrawer();
  document.body.classList.add('drawer-open');
  setTimeout(() => el('drawer-close')?.focus(), 0);
}
function closeDrawer() {
  state.drawerOpen = false;
  el('scrim').hidden = true;
  el('drawer').hidden = true;
  el('btn-connected').setAttribute('aria-expanded', 'false');
  document.body.classList.remove('drawer-open');
}

function renderDrawer() {
  const list = state.items;
  const active = list.filter((i) => i.enabled !== false).length;
  const problem = list.filter((i) => readinessOf(i) === 'credential-invalid').length;
  el('drawer-stats').innerHTML = list.length
    ? `<span class="stat ok"><b>${active}</b><span>${t('statConnected')}</span></span>` +
      `<span class="stat${problem ? ' bad' : ''}"><b>${problem}</b><span>${t('statProblem')}</span></span>`
    : '';
  if (!list.length) {
    el('drawer-rows').innerHTML = emptyHtml('connectedEmpty', 'connectedEmptyHint');
    return;
  }
  el('drawer-rows').innerHTML = `<div class="rows">${list.map(rowHtml).join('')}</div>`;
}

function rowHtml(item) {
  const r = readinessOf(item);
  const st = stateLabelFor(r);
  const expiring = item.credential?.expiringSoon && !item.credential?.expired;
  const expired = item.credential?.expired;
  let note = '';
  let noteClass = '';
  if (r === 'credential-invalid') { note = `${t('businessInvalid')} — ${t('hintReauth')}`; noteClass = 'bad'; }
  else if (expired) { note = t('credentialExpired'); noteClass = 'bad'; }
  else if (expiring) { note = t('credentialExpiring'); noteClass = 'warn'; }
  /* 已验证是默认状态：状态药丸已经说了，不再重复一行备注。 */
  else if (item.diagnostic?.message) { note = esc(item.diagnostic.message); }
  else if (r === 'unknown') { note = t('businessUnknown'); noteClass = 'warn'; }

  const canRepair = item.authMode === 'bearer' || item.authMode === 'api-key';
  const actions = [];
  if (r === 'credential-invalid' && canRepair) actions.push(`<button class="tbtn fix" data-act="repair" data-key="${esc(item.key)}" data-mode="${esc(item.authMode)}">${t('repair')}</button>`);
  actions.push(`<button class="tbtn" data-act="${item.enabled === false ? 'enable' : 'disable'}" data-key="${esc(item.key)}">${item.enabled === false ? t('enable') : t('disable')}</button>`);
  actions.push(`<button class="tbtn danger" data-act="disconnect" data-key="${esc(item.key)}">${t('disconnect')}</button>`);

  return `<article class="row" data-readiness="${r}">
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
      </div>
      ${note ? `<div class="row-note ${noteClass}">${note}</div>` : ''}
    </div>
    <div class="row-actions">${actions.join('')}</div>
  </article>`;
}

/* ── 交互 ───────────────────────────────────────────── */
async function onAction(act, target) {
  const key = target.dataset.key;
  if (act === 'repair') return openRepair(key, target.dataset.mode);
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
    if (res.ok) return loadAll();
    // OAuth 缺 DCR（或 DCR 被拒）：让用户补自己登记的 client_id / secret，而不是干瞪眼。
    if (res.detail?.recoverable === 'provide-oauth-client') {
      return openOAuthClientDialog(target.dataset.id);
    }
    if (/凭据|credential|api.?key|token/i.test(res.message || '')) {
      // 后端已在 detail 回传 connectorId；这里再兜一层，确保修复对话框拿得到 id，
      // 否则 configure 会因空 id 落到手工连接分支而必然失败。
      const detail = { ...(res.detail || {}), connectorId: res.detail?.connectorId || target.dataset.id };
      return openRepair('', res.detail?.authMode || 'bearer', detail);
    }
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
    if (res.ok) { closeDialog(); await loadAll(); }
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
  mask._ctx = { key, mode, connectDetail, connectorId: connectDetail?.connectorId || connectDetail?.id || '' };
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
      const id = ctx.connectorId || ctx.connectDetail?.connectorId || ctx.connectDetail?.id;
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
    if (res.ok) { closeDialog(); await loadAll(); }
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
  mask._ctx = null;
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
    if (res.ok) { closeDialog(); await loadAll(); }
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

async function checkPluginUpdate() {
  const button = el('btn-check-update');
  if (button.disabled) return;
  const result = el('plugin-update-result');
  const status = el('plugin-update-status');
  const download = el('plugin-update-download');
  const release = el('plugin-update-release');
  button.disabled = true;
  result.hidden = false;
  download.hidden = release.hidden = true;
  status.textContent = t('checkingUpdate');
  release.href = 'https://github.com/hh5631/dsh-connector-hub/releases';
  try {
    const response = await fetch('/api/dsh-connector-hub/update-check', {
      credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error('Update endpoint unavailable');
    const info = await response.json();
    if (info?.ok !== true) {
      status.textContent = (info?.current ? `v${info.current} · ` : '') + t('updateFailed');
      return;
    }
    const key = info.status === 'available' ? 'updateAvailable' : info.status === 'ahead' ? 'updateAhead' : 'updateCurrent';
    status.textContent = t('updateVersions', { current: info.current, latest: info.latest, status: t(key) });
    release.href = info.releaseUrl;
    if (info.downloadUrl) { download.href = info.downloadUrl; download.hidden = false; }
  } catch { status.textContent = t('updateFailed'); }
  finally { release.hidden = false; button.disabled = false; }
}

/* ── 事件绑定 ───────────────────────────────────────── */
function bind() {
  // 目录里的远程图标可能 404（含历史遗留路径、外部站点失效）：加载失败时换成内联默认图标，
  // 用捕获阶段监听（img 的 error 不冒泡），比每个 <img> 挂 onerror 更干净。
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG' || !img.classList?.contains('ci-img')) return;
    const I = window.ConnectorIcons;
    if (!I) return;
    const span = document.createElement('span');
    span.className = 'ci-emoji';
    span.innerHTML = I.iconSvg(I.DEFAULT_ICON, 16);
    img.replaceWith(span);
  }, true);

  el('search').addEventListener('input', (e) => { state.query = e.target.value; state.page = 0; render(); });
  el('btn-refresh').addEventListener('click', () => loadAll());
  el('btn-check-update').addEventListener('click', () => void checkPluginUpdate());
  el('btn-add').addEventListener('click', openAdd);

  // 已连接抽屉
  el('btn-connected').addEventListener('click', () => (state.drawerOpen ? closeDrawer() : openDrawer()));
  el('drawer-close').addEventListener('click', closeDrawer);
  el('scrim').addEventListener('click', closeDrawer);

  // 目录布局切换：列表 / 栅格，选择记在 localStorage。
  el('layout-switch').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-layout]');
    if (!btn) return;
    state.layout = btn.dataset.layout === 'grid' ? 'grid' : 'list';
    try { localStorage.setItem('connector-hub:layout', state.layout); } catch { /* 沙箱忽略 */ }
    render();
  });

  // 分组切换
  el('groupbar').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-group]');
    if (!btn) return;
    state.group = btn.dataset.group;
    state.page = 0;
    render();
  });

  // 分页：纯本地切片，不发请求。
  el('pager').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-page]');
    if (!btn || btn.disabled || !el('pager')._onPage) return;
    const delta = btn.dataset.page === 'prev' ? -1 : 1;
    el('pager')._onPage(Math.max(0, state.page + delta));
    el('content').scrollTop = 0;
  });

  // 目录卡片 / 抽屉里的动作
  el('content').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (btn) onAction(btn.dataset.act, btn);
  });
  el('drawer').addEventListener('click', (e) => {
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
      const connectorId = ctx?.connectorId || ctx?.connectDetail?.connectorId || ctx?.connectDetail?.id;
      if (!connectorId) return;
      el('mask').querySelector('[data-dlg="reuse-cli"]').disabled = true;
      call('reuseCliAuth', { connectorId }).then(async (res) => {
        toast(res.message);
        if (res.ok) { closeDialog(); await loadAll(); }
        else { const help = el('repair-help'); if (help) help.textContent = res.message || ''; }
      });
    }
    else if (act === 'add-save') submitAdd();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!el('mask').hidden) return closeDialog();
    if (state.drawerOpen) closeDrawer();
  });

  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin || !event.data || typeof event.data !== 'object') return;
    if (event.data.type === 'connector-hub:workspace-context') {
      const ws = event.data.workspace;
      state.workspaceId = ws?.workspaceId ? String(ws.workspaceId) : '';
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
  const scheduleRefresh = (event) => {
    if (document.hidden) return;
    // 连接/目录类事件之外（心跳等）不必重取；两种情况都只是重取 18KB 目录 + 状态。
    let type = '';
    try { type = JSON.parse(event?.data ?? '{}')?.type ?? ''; } catch { /* 心跳等非 JSON 忽略 */ }
    if (type && type !== 'catalog' && type !== 'connection' && type !== 'status') return;
    clearTimeout(refreshTimer);
    // SSE 刷新只重取状态/目录，绝不调 healthCheck（后者会再发 status 事件 → 自激循环）。
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
  el('view-title').textContent = t('brand');
  el('section-label').textContent = t('subtitle');
  el('search').placeholder = t('search');
  el('btn-refresh').textContent = t('refresh');
  el('btn-check-update').textContent = t('checkUpdate');
  el('plugin-update-download').textContent = t('downloadUpdate');
  el('plugin-update-release').textContent = t('updateReleases');
  el('btn-add').textContent = t('add');
  el('connected-label').textContent = t('connected');
  el('drawer-title').textContent = t('connectedTitle');
  el('drawer-close').textContent = t('close');
  el('list-title').textContent = t('catalog');
  const layoutSwitch = el('layout-switch');
  if (layoutSwitch) {
    const lb = layoutSwitch.querySelector('[data-layout="list"]');
    const gb = layoutSwitch.querySelector('[data-layout="grid"]');
    if (lb) { lb.title = t('layoutList'); lb.setAttribute('aria-label', t('layoutList')); }
    if (gb) { gb.title = t('layoutGrid'); gb.setAttribute('aria-label', t('layoutGrid')); }
  }
}

// 先应用 Host 注入的字体（服务端已读好宿主配置），保证首帧就是正确字体；
// 后续 postMessage 只用于用户当场改字体时的实时更新。
try { applyHostFonts(window.__CONNECTOR_HUB_FONTS__); } catch { /* 独立打开时无注入 */ }

applyStaticText();
bind();
// 首屏：有上次的快照就立刻渲染（0 等待），再静默刷新；没有就走 loadAll。
// 只取状态 + 目录，绝不跑健康检查 —— 那是面板卡顿的根因。
const snapshot = readSnapshot();
if (snapshot && snapshot.workspaceId === state.workspaceId) {
  state.items = snapshot.items;
  state.catalog = snapshot.catalog;
  state.loaded = true;
  render();
}
loadAll();
