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
    if (!res.ok && data.ok !== false) return { ok: false, message: t('reqFailedHttp', { status: res.status }) };
    return data;
  } catch (error) {
    return { ok: false, message: error?.name === 'AbortError' ? t('reqTimeout') : t('reqFailed', { msg: error?.message || error }) };
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

/* 打开抽屉/对话框前记住焦点，关闭后归还，键盘用户不会「掉」回页面顶部。
   用栈而非单槽：抽屉里再弹修复对话框时，逐层归还才不会把焦点丢给 body。 */
const _focusStack = [];
function captureFocus(origin) {
  // 显式传入触发按钮最可靠（Safari 点击 button 不一定会聚焦）；否则退回 activeElement。
  let a = origin;
  if (!a) { try { a = document.activeElement; } catch { a = null; } }
  _focusStack.push((a && typeof a.focus === 'function') ? a : null);
}
/* ── 焦点圈定 ─────────────────────────────────────────
 * 抽屉与弹层都有遮罩，本质是模态：Tab 必须在里面打转，
 * 不能让键盘用户一按 Tab 就掉到背后的目录里（那里点不到但有读屏）
 * 或干脆跳出 iframe。两个容器共用一套实现，不做两遍。
 */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
function focusablesIn(node) {
  if (!node || typeof node.querySelectorAll !== 'function') return [];
  try { return [...node.querySelectorAll(FOCUSABLE)]; } catch { return []; }
}
/** 把 Tab / Shift+Tab 限制在 root 内；root 内没有可聚焦元素时保持焦点不动。 */
function trapTab(event, root) {
  if (event.key !== 'Tab' || !root) return false;
  const list = focusablesIn(root).filter((n) => n.offsetParent !== null || n === root);
  if (!list.length) { event.preventDefault?.(); return true; }
  const first = list[0];
  const last = list[list.length - 1];
  const active = (() => { try { return document.activeElement; } catch { return null; } })();
  const inside = active && (root === active || (typeof root.contains === 'function' && root.contains(active)));
  if (!inside) { event.preventDefault?.(); first.focus?.(); return true; }
  if (event.shiftKey && active === first) { event.preventDefault?.(); last.focus?.(); return true; }
  if (!event.shiftKey && active === last) { event.preventDefault?.(); first.focus?.(); return true; }
  return false;
}

function restoreFocus() {
  const a = _focusStack.pop();
  try { if (a && typeof a.focus === 'function') a.focus(); } catch { /* 节点已随重渲染移除时忽略 */ }
}
/* 单次网络动作期间锁住触发按钮，防重复点击；结束后无论成败都解锁。 */
async function withBusy(node, fn) {
  if (node) node.disabled = true;
  try { return await fn(); } finally { if (node) node.disabled = false; }
}

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
    connected: '已连接', connectedTitle: '已连接的应用', close: '关闭',
    connectedEmpty: '还没有连接任何应用', connectedEmptyHint: '在上方目录里挑一个，点「连接」即可。',
    noCatalog: '目录为空', noCatalogHint: '检查网络，或点「刷新」重新拉取目录。',
    noMatch: '没有匹配“{q}”的内容', noMatchPlain: '这个分类还没有内容',
    noMatchHint: '换一个关键词，或清除筛选条件。',
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
    invalid: '凭据已失效', idle: '已停用',
    reqTimeout: '请求超时，请重试', reqFailedHttp: '请求失败（HTTP {status}）', reqFailed: '请求失败：{msg}',
    oauthClientSecretHint: '（机密客户端才需要）', connectorLabel: '连接器',
    tokenPlaceholderBearer: 'API Token', tokenPlaceholderKey: 'API Key',
    addHint: '粘贴 MCP 连接配置 JSON（{ "mcpServers": { … } }），或填写连接器描述 URL。',
    addJson: 'JSON 配置', addUrl: '或：描述文件 URL', addRequired: '请填写 JSON 或 URL',
    clearFilters: '清除筛选', searchShortcut: '按 / 或 ⌘K 聚焦搜索',
    manage: '管理', clearSearch: '清除搜索', toastClose: '知道了',
    viewGroup: '视图', loadingText: '正在读取…',
  },
  en: {
    brand: 'Connector', subtitle: 'External service access', catalog: 'Catalog',
    search: 'Search connectors…', refresh: 'Refresh', add: 'Add connection',
    connected: 'Connected', connectedTitle: 'Connected apps', close: 'Close',
    connectedEmpty: 'Nothing connected yet', connectedEmptyHint: 'Pick one from the catalog above and hit Connect.',
    noCatalog: 'Catalog is empty', noCatalogHint: 'Check the network, or press Refresh to reload.',
    noMatch: 'Nothing matches “{q}”', noMatchPlain: 'Nothing in this category yet',
    noMatchHint: 'Try another keyword, or clear the filters.',
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
    invalid: 'Credential invalid', idle: 'Disabled',
    reqTimeout: 'Request timed out, please retry', reqFailedHttp: 'Request failed (HTTP {status})', reqFailed: 'Request failed: {msg}',
    oauthClientSecretHint: '(confidential clients only)', connectorLabel: 'Connector',
    tokenPlaceholderBearer: 'API Token', tokenPlaceholderKey: 'API Key',
    addHint: 'Paste MCP connection config JSON ({ "mcpServers": { … } }), or enter a connector descriptor URL.',
    addJson: 'JSON config', addUrl: 'Or: descriptor URL', addRequired: 'Please enter JSON or a URL',
    clearFilters: 'Clear filters', searchShortcut: 'Press / or ⌘K to focus search',
    manage: 'Manage', clearSearch: 'Clear search', toastClose: 'Dismiss',
    viewGroup: 'View', loadingText: 'Loading…',
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
  if (!node) return;
  node.textContent = message;
  node.hidden = false;
  node.dataset.kind = kind;
  // 长消息（后端原样透传的错误）按字数延长停留，避免还没读完就消失
  const dwell = Math.min(10000, Math.max(4200, String(message || '').length * 160));
  clearTimeout(node._timer);
  node._timer = setTimeout(() => { node.hidden = true; }, dwell);
}

/** 点击 toast 立即收起：它是临时提示，不该让人等。 */
function bindToastDismiss() {
  const node = el('toast');
  if (!node || typeof node.addEventListener !== 'function') return;
  node.addEventListener('click', () => { clearTimeout(node._timer); node.hidden = true; });
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
  // 每次取数据都进加载态：首屏铺骨架，后续只给刷新按钮转圈。
  setLoading(true);
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

/**
 * 加载态。
 *
 * 这里有一条硬约束：**任何加载提示都不允许占据布局高度**。
 * 早先的实现里 `#loading` 在每次 refresh 时 `hidden = false`，
 * 那一行「正在读取…」有 19.2px 高，把下面的目录整片往下推，
 * 数据回来又弹回去 —— 这就是「打开连接器会抖一下」的直接原因。
 *
 * 现在的分工：
 *   · 首屏（还没有任何数据）：铺骨架卡片 + 骨架分组条，形状与真实内容一致，
 *     数据到达时是「填内容」，所有元素的位置一开始就定了。
 *   · 后续刷新（已有内容）：完全不碰 DOM 结构，只在刷新按钮上转圈。
 *   · 读屏播报：aria-busy 挂在内容容器上，不占像素。
 */
function setLoading(on) {
  state.loading = on;
  const node = el('loading');
  try {
    // 提示文字永不参与布局，只服务读屏
    if (node) {
      node.hidden = true;
      node.setAttribute('aria-busy', 'false');
      if (node.classList) node.classList.add('visually-hidden');
    }
    const content = el('content');
    if (content && content.setAttribute) content.setAttribute('aria-busy', String(Boolean(on)));
  } catch { /* 测试桩忽略 */ }

  if (!node && !el('rows')) return;
  try {
    if (on && !state.loaded) {
      const rows = el('rows');
      if (!rows) return;
      const cards = state.layout === 'grid' ? 'grid grid-cards' : 'grid grid-list';
      // 6 张就够铺满一屏，多画只是浪费
      rows.innerHTML = `<div class="${cards}" aria-hidden="true">${'<div class="skeleton"></div>'.repeat(6)}</div>`;
      // 分组条也必须先占好位：它默认 hidden，数据到达时才出现会把下方整片内容
      // 推下去 49px。骨架阶段先画一排等宽灰条，数据回来后是「填内容」。
      renderGroupBarSkeleton();
      return;
    }
    const btn = el('btn-refresh');
    if (btn && btn.dataset) {
      if (on) btn.dataset.busy = '1';
      else delete btn.dataset.busy;
    }
  } catch { /* 测试桩忽略 */ }
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

/* ── 动效：只回应操作，且尊重「减少动态效果」 ───────────
 * 翻页、切分类、换布局都是「同一块区域整片换内容」。
 * 直接替换 innerHTML 会让整块内容瞬移，眼睛会跟丢；这里做一次很短的
 * 交叉淡入（旧内容上浮淡出 → 换内容 → 新内容下沉淡入），并把滚动位置
 * 平滑送回顶部。两类动作各约 90–160ms，比一次眨眼还短，但方向感清楚。
 * `prefers-reduced-motion` 下全部退化为立即替换。
 */
function prefersReducedMotion() {
  try { return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true; } catch { return false; }
}

/** 内容区回到顶部：翻页后用平滑滚动，避免「瞬移」的割裂感。 */
function scrollContentTop(smooth) {
  const node = el('content');
  if (!node) return;
  try {
    if (smooth && !prefersReducedMotion() && typeof node.scrollTo === 'function') {
      node.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      node.scrollTop = 0;
    }
  } catch { /* 测试桩忽略 */ }
}

/* 每次切换递增的令牌：连点翻页时只有最后一次的结果会落地，不会两批内容打架。 */
let swapToken = 0;
const LEAVE_MS = 90;

/**
 * 交叉淡入地替换列表内容。
 * mutate 负责真正写 innerHTML；离开动画结束后才动内容，避免半截内容闪一下。
 */
function crossfadeRows(mutate) {
  const rows = el('rows');
  if (!rows || !rows.classList || prefersReducedMotion()) { mutate(); return; }
  const token = ++swapToken;
  try { clearTimeout(rows._leaveTimer); clearTimeout(rows._enterTimer); } catch { /* 桩忽略 */ }
  rows.classList.add('rows-leaving');
  rows._leaveTimer = setTimeout(() => {
    if (token !== swapToken) return;
    mutate();
    rows.classList.remove('rows-leaving');
    rows.classList.remove('rows-enter');
    void rows.offsetWidth; // 强制回流，让同名入场动画能重播
    rows.classList.add('rows-enter');
    rows._enterTimer = setTimeout(() => {
      if (token === swapToken) rows.classList.remove('rows-enter');
    }, 240);
  }, LEAVE_MS);
}

/** 标记「下一次列表渲染来自用户切页/切分类」，renderCatalog 会据此播放过渡。 */
let animateNext = false;

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

/**
 * 分组条骨架：在数据回来之前先占住分组条的高度。
 * 宽度按常见分类名的字宽估算，切换时下方内容完全不动。
 */
const GROUP_SKELETON = [[26, 34], [44, 34], [44, 34], [44, 34], [44, 34], [44, 34]];
function renderGroupBarSkeleton() {
  const bar = el('groupbar');
  if (!bar) return;
  bar.innerHTML = GROUP_SKELETON
    .map(([label, count]) => `<span class="groupbar-sk" aria-hidden="true"><i style="width:${label}px"></i><i class="n" style="width:${count}px"></i></span>`)
    .join('');
  // 骨架阶段还没有真实分类，墨条不该显示（否则底部会多一道黑线）
  const ink = bar.querySelector('.groupbar-ink');
  if (ink) ink.dataset.ready = '0';
  bar.dataset.empty = '0';
  bar.setAttribute('aria-hidden', 'false');
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
  const bar = el('groupbar');
  bar.innerHTML = counts.size
    ? keys.map((k) => `<button type="button" data-group="${k}" aria-pressed="${state.group === k}">${groupLabel(k)}<span class="n">${counts.get(k) ?? 0}</span></button>`).join('')
      // 选中墨条是「一枚」元素，在按钮之间滑行；不用每个按钮各画一条下划线。
      + '<span class="groupbar-ink" data-ready="0" aria-hidden="true"></span>'
    : '';
  // 不再用 hidden 切换：分组条常在，隐藏/显示会把下方整片内容推上推下。
  // 空数据时只标记 data-empty，视觉上留白但高度不变。
  bar.dataset.empty = counts.size ? '0' : '1';
  bar.setAttribute('aria-hidden', counts.size ? 'false' : 'true');
  syncGroupInk();
}

/**
 * 把滑动墨条对齐到当前选中的分组按钮。
 *
 * 用 offsetLeft/offsetTop/offsetWidth（groupbar 是定位容器）而不是
 * getBoundingClientRect，这样面板滚动时也不会算错。
 * 同时写 x 与 y：窄面板里分组条可能折行，墨条必须贴住被选中那一行，
 * 而不是永远待在容器底部。测试桩没有布局信息时静默跳过。
 */
function syncGroupInk() {
  const bar = el('groupbar');
  if (!bar || typeof bar.querySelector !== 'function') return;
  const ink = bar.querySelector('.groupbar-ink');
  const active = bar.querySelector('button[aria-pressed="true"]');
  if (!ink || !active || !ink.style) return;
  const left = Number(active.offsetLeft) || 0;
  const top = Number(active.offsetTop) || 0;
  const height = Number(active.offsetHeight) || 0;
  const width = Number(active.offsetWidth) || 0;
  ink.style.width = `${width}px`;
  // -1px：让墨条压在分组条那条发丝线上，而不是浮在它上方
  ink.style.transform = `translate(${left}px, ${top + height - 1}px)`;
  ink.dataset.ready = '1';
}

/** 面板宽度变化后重算墨条位置（折行与否会改变行的位置）。 */
function relayoutGroupInk() {
  try { syncGroupInk(); } catch { /* 桩忽略 */ }
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
    <span class="info page-no">${page + 1} / ${pages}</span>
    <button class="tbtn" data-page="next" ${page + 1 >= pages ? 'disabled' : ''}>${t('next')}</button>`;
  pager._onPage = onPage;
}

function pageSlice(list, page, pageSize) {
  const pages = Math.max(1, Math.ceil(list.length / pageSize));
  // 数据变少时把页码收回到最后一页，调用方会写回 state.page。
  const p = Math.min(Math.max(0, page), pages - 1);
  return { p, items: list.slice(p * pageSize, p * pageSize + pageSize) };
}

/**
 * 空状态。把用户输入的关键词回显在提示里（「没有匹配 “xxx” 的内容」），
 * 让人确认是搜错了字而不是数据没了；再给一个可点的下一步。
 */
function emptyHtml(titleKey, hintKey, action = '', quote = '') {
  let btn = '';
  if (action === 'clear') btn = `<div class="empty-actions"><button class="tbtn strong" type="button" data-act="clear-filters">${esc(t('clearFilters'))}</button></div>`;
  else if (action === 'refresh') btn = `<div class="empty-actions"><button class="tbtn" type="button" data-act="refresh">${esc(t('refresh'))}</button></div>`;
  // 没有关键词（只是分类下没数据）时用不带占位符的标题，避免出现空的引号
  const title = quote ? t(titleKey).replace('{q}', quote) : t('noMatchPlain');
  return `<div class="empty"><strong>${esc(title)}</strong>${esc(t(hintKey))}${btn}</div>`;
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
    const filtered = !!q || state.group !== 'all';
    el('rows').innerHTML = emptyHtml(
      filtered ? 'noMatch' : 'noCatalog',
      filtered ? 'noMatchHint' : 'noCatalogHint',
      filtered ? 'clear' : 'refresh',
      q ? state.query.trim() : '',
    );
    renderPager(0, 0, state.pageSize, () => {});
    return;
  }
  const gridClass = state.layout === 'grid' ? 'grid grid-cards' : 'grid grid-list';
  const paint = () => {
    el('rows').innerHTML = `<div class="${gridClass}">${slice.items.map((c) => cardHtml(c, state.layout)).join('')}</div>`;
  };
  // 只在用户主动翻页 / 切分类时过渡；SSE 静默刷新不闪。
  if (animateNext) { animateNext = false; crossfadeRows(paint); } else { paint(); }
  renderPager(list.length, slice.p, state.pageSize, (p) => {
    animateNext = true;
    state.page = p;
    renderCatalog(state.query.trim().toLowerCase());
  });
}

/** 统一图标出口：目录项、抽屉行都走它；icons.js 未加载时退回首字母，绝不开天窗。 */
function iconHtmlFor(item, size, name) {
  if (window.ConnectorIcons?.iconHtml) return window.ConnectorIcons.iconHtml(item, size);
  return `<span class="ci-emoji">${esc(String(name ?? item.name ?? item.id ?? '?').trim().charAt(0).toUpperCase())}</span>`;
}

/**
 * 目录卡片。两种布局共用同一套语义结构，只是排列不同：
 *   图标 + 名称（含已连接点 + id）+ 厂商 + 简介 + [分类 · 鉴权] + 操作。
 * 栅格卡片把操作压到右下、分类鉴权压在左下，底边贴齐卡片底；
 * 列表行把元信息收进同一条水平带，整行只有一条 0.5px 分隔（不画成小卡片）。
 */
function cardHtml(c, layout = 'list') {
  const connected = (c.connected?.length ?? 0) > 0;
  // 图标优先用目录自带 icon（URL/emoji/图标名），否则按 id / 类目挑线性矢量图标。
  const icon = iconHtmlFor(c, layout === 'grid' ? 20 : 18, c.name);
  const meta = `<span>${esc(c.category || '')}</span><span>${esc(authLabel({ authMode: c.authMode }))}</span>`;
  // 绿点纯装饰（aria-hidden），已有「管理」按钮表达同一件事，不再挂中文 tooltip
  const dot = connected ? '<span class="dot-ok" aria-hidden="true"></span>' : '';
  // 已连接的项目不再走 connect（那会重复建连），改为打开「已连接」抽屉去管理。
  // 列表里会有几十个同名按钮：给每个补上「动作 + 对象」的无障碍名字，
  // 否则读屏用户听到的只是一串「连接 / 管理」，分不清是哪一条。
  const act = connected
    ? `<button class="tile-act is-on" type="button" data-act="open-drawer" aria-label="${esc(`${t('manage')} ${c.name}`)}">${t('manage')}</button>`
    : `<button class="tile-act" type="button" data-act="connect" data-id="${esc(c.id)}" aria-label="${esc(`${t('connect')} ${c.name}`)}">${t('connect')}</button>`;

  if (layout === 'grid') {
    return `<article class="tile"${connected ? ' data-connected="1"' : ''}>
      <div class="tile-head">
        <div class="tile-icon">${icon}</div>
        <div class="tile-ident">
          <div class="tile-name">${esc(c.name)}${dot}</div>
          <div class="tile-vendor">${esc(c.vendor || '')}</div>
        </div>
      </div>
      <div class="tile-desc">${esc(c.summary || '')}</div>
      <div class="tile-foot">
        <div class="tile-tags">${meta}</div>
        ${act}
      </div>
    </article>`;
  }
  // 列表视图精简列：图标 + 名称/ID + 一行简介 + 分类·鉴权 + 操作，去掉厂商独立行。
  return `<article class="tile"${connected ? ' data-connected="1"' : ''}>
    <div class="tile-icon">${icon}</div>
    <div class="tile-ident">
      <div class="tile-name">${esc(c.name)}${dot} <span class="chip">${esc(c.id)}</span></div>
      <div class="tile-desc tile-desc-clamp">${esc(c.summary || '')}</div>
    </div>
    <div class="tile-tags">${meta}</div>
    <div class="tile-foot">${act}</div>
  </article>`;
}

/* ── 已连接抽屉 ─────────────────────────────────────── */
function openDrawer() {
  captureFocus(el('btn-connected'));
  state.drawerOpen = true;
  el('scrim').hidden = false;
  el('drawer').hidden = false;
  el('btn-connected').setAttribute('aria-expanded', 'true');
  renderDrawer();
  document.body.classList.add('drawer-open');
  // 焦点交给抽屉容器本身（tabindex=-1）：读屏与键盘用户立刻落到抽屉里，
  // 但鼠标打开时不会在「关闭」按钮上留下一圈本不该有的焦点环。
  setTimeout(() => {
    const drawer = el('drawer');
    try { drawer?.focus?.({ preventScroll: true }); } catch { /* 老浏览器忽略参数 */ }
  }, 0);
}
function closeDrawer() {
  state.drawerOpen = false;
  el('scrim').hidden = true;
  el('drawer').hidden = true;
  el('btn-connected').setAttribute('aria-expanded', 'false');
  document.body.classList.remove('drawer-open');
  restoreFocus();
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
  // 重新渲染后内容换了一批，滚动位置必须收回顶部，否则会停在半截列表中间
  try { el('drawer-rows').scrollTop = 0; } catch { /* 测试桩忽略 */ }
}

function rowHtml(item) {
  const r = readinessOf(item);
  const st = stateLabelFor(r);
  const expiring = item.credential?.expiringSoon && !item.credential?.expired;
  const expired = item.credential?.expired;
  let note = '';
  let noteClass = '';
  // 失效行的药丸已经写了「凭据已失效」，备注只留「怎么办」这一步，不再重复诊断。
  if (r === 'credential-invalid') { note = t('hintReauth'); noteClass = 'bad'; }
  else if (expired) { note = t('credentialExpired'); noteClass = 'bad'; }
  else if (expiring) { note = t('credentialExpiring'); noteClass = 'warn'; }
  /* 已验证是默认状态：状态药丸已经说了，不再重复一行备注。 */
  else if (item.diagnostic?.message) { note = esc(item.diagnostic.message); }
  else if (r === 'unknown') { note = t('businessUnknown'); noteClass = 'warn'; }

  const canRepair = item.authMode === 'bearer' || item.authMode === 'api-key';
  const actions = [];
  const who = esc(item.name);
  if (r === 'credential-invalid' && canRepair) actions.push(`<button class="tbtn fix" data-act="repair" data-key="${esc(item.key)}" data-mode="${esc(item.authMode)}" aria-label="${esc(`${t('repair')} ${item.name}`)}">${t('repair')}</button>`);
  const toggleLabel = item.enabled === false ? t('enable') : t('disable');
  actions.push(`<button class="tbtn" data-act="${item.enabled === false ? 'enable' : 'disable'}" data-key="${esc(item.key)}" aria-label="${esc(`${toggleLabel} ${item.name}`)}">${toggleLabel}</button>`);
  actions.push(`<button class="tbtn danger" data-act="disconnect" data-key="${esc(item.key)}" aria-label="${esc(`${t('disconnect')} ${item.name}`)}">${t('disconnect')}</button>`);

  const icon = iconHtmlFor({ id: item.connectorId, category: catalogCategoryOf(item.connectorId), transport: item.transport }, 16, item.name);

  /* 正常可用是默认状态，不必每行都挂一个「已连接」药丸——竖脊与图标底色已经说了。
     只在需要人注意时（失效 / 待确认 / 已停用 / 即将过期）才出标签，抽屉才安静。 */
  const quiet = r === 'verified' && !expired && !expiring;
  // 需要人动手的行（凭据失效 / 待确认 / 已停用 / 凭据将过期）让动作常驻；
  // 正常行把动作收进悬停态，抽屉才安静。两者位置一致，不会让人到处找按钮。
  const needsAttention = !quiet;
  return `<article class="row" data-readiness="${r}"${needsAttention ? ' data-attention="1"' : ''}>
    <div class="row-icon">${icon}</div>
    <div class="row-main">
      <div class="row-title">
        <strong>${esc(item.name)}</strong>
        <span class="chip">${esc(item.serverName)}</span>
        ${quiet ? '' : `<span class="state-label ${st.cls}">${st.text}</span>`}
        ${/* 状态本就是「失效」时不再叠一个「已过期」，避免同义标签并排；其余情况才补。 */ ''}
        ${r !== 'credential-invalid' && (expired || expiring) ? `<span class="state-label ${expired ? 'bad' : 'warn'}">${expired ? t('credentialExpired') : t('credentialExpiring')}</span>` : ''}
      </div>
      <div class="row-line">
        <div class="row-meta">
          <span>${esc(authLabel(item))}</span>
          ${item.transport ? `<span>${esc(item.transport)}</span>` : ''}
          <span>${scopeLabel(item)}</span>
        </div>
        <div class="row-actions">${actions.join('')}</div>
      </div>
      ${note ? `<div class="row-note ${noteClass}">${note}</div>` : ''}
    </div>
  </article>`;
}

/* ── 交互 ───────────────────────────────────────────── */
async function onAction(act, target) {
  const key = target.dataset.key;
  if (act === 'clear-filters') {
    state.query = ''; state.group = 'all'; state.page = 0;
    const search = el('search'); if (search) search.value = '';
    return render();
  }
  if (act === 'refresh') return loadAll();
  if (act === 'open-drawer') { if (!state.drawerOpen) openDrawer(); return; }
  if (act === 'repair') return openRepair(key, target.dataset.mode, undefined, target);
  if (act === 'enable' || act === 'disable') {
    return withBusy(target, async () => {
      const res = await call('setEnabled', { key, enabled: act === 'enable' });
      toast(res.message);
      return loadAll();
    });
  }
  if (act === 'disconnect') {
    if (!confirm(t('confirmDisconnect'))) return;
    return withBusy(target, async () => {
      const res = await call('disconnect', { key });
      toast(res.message);
      return loadAll();
    });
  }
  if (act === 'connect') {
    const res = await withBusy(target, () => call('connect', { connectorId: target.dataset.id }));
    toast(res.message);
    if (res.ok) return loadAll();
    // OAuth 缺 DCR（或 DCR 被拒）：让用户补自己登记的 client_id / secret，而不是干瞪眼。
    if (res.detail?.recoverable === 'provide-oauth-client') {
      return openOAuthClientDialog(target.dataset.id, target);
    }
    if (/凭据|credential|api.?key|token/i.test(res.message || '')) {
      // 后端已在 detail 回传 connectorId；这里再兜一层，确保修复对话框拿得到 id，
      // 否则 configure 会因空 id 落到手工连接分支而必然失败。
      const detail = { ...(res.detail || {}), connectorId: res.detail?.connectorId || target.dataset.id };
      return openRepair('', res.detail?.authMode || 'bearer', detail, target);
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
function openOAuthClientDialog(connectorId, origin) {
  captureFocus(origin);
  document.body.classList.add('dialog-open');
  const mask = el('mask');
  mask.innerHTML = `<div class="dialog" role="dialog" aria-modal="true">
    <h2>${esc(t('oauthClientTitle'))}</h2>
    <p>${esc(t('oauthClientHint'))}</p>
    <div class="field"><label>${esc(t('oauthClientId'))}</label>
      <input id="oauth-client-id" class="mono" autocomplete="off" placeholder="Iv1.xxxxxxxxxxxx"></div>
    <div class="field"><label>${esc(t('oauthClientSecret'))}</label>
      <input type="password" id="oauth-client-secret" class="mono" autocomplete="off" placeholder="${esc(t('oauthClientSecretHint'))}"></div>
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

function openRepair(key, mode, connectDetail, origin) {
  captureFocus(origin);
  document.body.classList.add('dialog-open');
  const mask = el('mask');
  const isBearer = mode !== 'api-key';
  const title = connectDetail ? t('connect') : t('repairTitle');
  const hint = connectDetail ? (connectDetail.credentialDescription || t('repairHint')) : t('repairHint');
  const guide = connectDetail?.credentialGuide;
  const cliProviders = Array.isArray(connectDetail?.cliAuthProviders) ? connectDetail.cliAuthProviders : [];
  mask.innerHTML = `<div class="dialog" role="dialog" aria-modal="true">
    <h2>${esc(title)}</h2>
    <p>${esc(hint)}</p>
    ${connectDetail ? `<div class="field"><label>${esc(t('connectorLabel'))}</label><input class="mono" value="${esc(connectDetail.connectorId || connectDetail.id || '')}" disabled></div>` : ''}
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
      <input type="password" id="repair-value" class="mono" autocomplete="off" placeholder="${esc(isBearer ? t('tokenPlaceholderBearer') : t('tokenPlaceholderKey'))}">
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

function closeDialog() {
  el('mask').hidden = true;
  el('mask')._ctx = null;
  document.body.classList.remove('dialog-open');
  restoreFocus();
}

function openAdd(origin) {
  captureFocus(origin && typeof origin.focus === 'function' ? origin : el('btn-add'));
  document.body.classList.add('dialog-open');
  const mask = el('mask');
  mask.innerHTML = `<div class="dialog" role="dialog" aria-modal="true">
    <h2>${esc(t('add'))}</h2>
    <p>${esc(t('addHint'))}</p>
    <div class="field"><label>${esc(t('addJson'))}</label><textarea id="add-json" rows="6" class="mono" placeholder='{ "mcpServers": { "name": { "url": "https://…" } } }'></textarea></div>
    <div class="field"><label>${esc(t('addUrl'))}</label><input id="add-url" class="mono" placeholder="https://…/dsh-connector.json"></div>
    <div class="field"><div class="help" id="add-help"></div></div>
    <div class="dialog-actions">
      <button class="tbtn" data-dlg="cancel">${t('cancel')}</button>
      <button class="tbtn strong" data-dlg="add-save">${t('save')}</button>
    </div>
  </div>`;
  mask.hidden = false;
  mask._ctx = null;
  setTimeout(() => el('add-json')?.focus(), 0);
  bindAddValidation();
}

/**
 * 「添加连接」的即时校验：两个字段都空时保存不可点，填了任一即可。
 * 只在输入变化时改按钮状态，不做逐字符报错（那会让人边打字边被训）。
 */
function bindAddValidation() {
  const json = el('add-json');
  const url = el('add-url');
  const save = el('mask')?.querySelector?.('[data-dlg="add-save"]');
  const help = el('add-help');
  if (!save) return;
  const sync = () => {
    const filled = Boolean((json?.value || '').trim() || (url?.value || '').trim());
    try { save.disabled = !filled; } catch { /* 桩忽略 */ }
    if (filled && help) help.textContent = '';
  };
  sync();
  json?.addEventListener?.('input', sync);
  url?.addEventListener?.('input', sync);
}

async function submitAdd() {
  const json = el('add-json')?.value?.trim();
  const url = el('add-url')?.value?.trim();
  const help = el('add-help');
  if (!json && !url) { help.textContent = t('addRequired'); return; }
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

  bindToastDismiss();
  el('search').addEventListener('input', (e) => { state.query = e.target.value; state.page = 0; render(); });
  // 搜索框里的 Esc：先清关键词，已经是空的就让焦点离开（原生 search 行为不一致，自己定）
  el('search').addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const input = e.target || el('search');
    if (!input?.value) return;
    e.preventDefault?.();
    e.stopPropagation?.();
    input.value = '';
    state.query = ''; state.page = 0;
    render();
  });
  el('btn-refresh').addEventListener('click', () => loadAll());
  el('btn-add').addEventListener('click', openAdd);

  // 已连接抽屉
  el('btn-connected').addEventListener('click', () => (state.drawerOpen ? closeDrawer() : openDrawer()));
  el('drawer-close').addEventListener('click', closeDrawer);
  el('scrim').addEventListener('click', closeDrawer);

  // 目录布局切换：列表 / 栅格，选择记在 localStorage。
  // 换布局是「同一批内容换一种排法」，用过渡让卡片平滑重排，而不是整屏闪一下。
  el('layout-switch').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-layout]');
    if (!btn) return;
    const next = btn.dataset.layout === 'grid' ? 'grid' : 'list';
    if (next === state.layout) return;
    try { localStorage.setItem('connector-hub:layout', next); } catch { /* 沙箱忽略 */ }
    animateNext = true;
    state.layout = next;
    render();
  });

  // 分组切换：墨条滑到位 + 列表交叉淡入，页码归零。
  el('groupbar').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-group]');
    if (!btn) return;
    const next = btn.dataset.group;
    if (next === state.group) return;
    animateNext = true;
    state.group = next;
    state.page = 0;
    render();
    scrollContentTop(true);
  });

  // 分页：纯本地切片，不发请求。翻页时内容交叉淡入，滚动位置平滑回顶。
  el('pager').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-page]');
    if (!btn || btn.disabled || !el('pager')._onPage) return;
    const delta = btn.dataset.page === 'prev' ? -1 : 1;
    el('pager')._onPage(Math.max(0, state.page + delta));
    scrollContentTop(true);
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
      const btn = e.target.closest('[data-dlg="reuse-cli"]');
      withBusy(btn, async () => {
        const res = await call('reuseCliAuth', { connectorId });
        toast(res.message);
        if (res.ok) { closeDialog(); await loadAll(); }
        else { const help = el('repair-help'); if (help) help.textContent = res.message || ''; }
      });
    }
    else if (act === 'add-save') submitAdd();
  });
  document.addEventListener('keydown', (e) => {
    // 弹层优先吃 Tab（叠在抽屉之上时只有它该响应）
    const mask = el('mask');
    if (!mask.hidden && trapTab(e, mask.querySelector('.dialog'))) return;
    if (mask.hidden && state.drawerOpen && trapTab(e, el('drawer'))) return;
    if (e.key === 'Escape') {
      if (!mask.hidden) return closeDialog();
      if (state.drawerOpen) closeDrawer();
      return;
    }
    // 「/」与 ⌘K / Ctrl+K 快速聚焦搜索；弹层打开时不抢焦点，输入框里的 '/' 正常输入。
    // 抽屉打开时不拦：搜索是全局动作，用户在抽屉里也想切到搜索。
    const focusSearch = e.key === '/' || ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K'));
    if (!focusSearch || !el('mask').hidden) return;
    if (state.drawerOpen && e.key === '/') return;
    const tag = e.target?.tagName;
    const editable = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable;
    if (editable && e.key === '/') return;
    const search = el('search');
    if (!search) return;
    e.preventDefault?.();
    if (state.drawerOpen) closeDrawer();
    search.focus();
    if (typeof search.select === 'function') search.select();
  });

  /* 面板宽度自适应：iframe 被拖宽/拖窄时调整每页条数，宽面板不空、窄面板不挤。
     决策在 ui/responsive.js（纯函数、可单测），这里只应用结果。
     ResizeObserver 缺失或 vm 测试桩里静默回退，不影响功能。 */
  const applyResponsive = () => {
    const R = window.ConnectorResponsive;
    if (!R || typeof R.pageSizeFor !== 'function') return;
    const width = (() => {
      try { return document.documentElement?.clientWidth || window.innerWidth || 0; } catch { return 0; }
    })();
    const next = R.pageSizeFor(width, 12);
    if (next !== state.pageSize) { state.pageSize = next; render(); }
    else relayoutGroupInk();
    try { document.documentElement.dataset.breakpoint = R.breakpointFor(width); } catch { /* 桩忽略 */ }
  };
  try {
    if (typeof ResizeObserver !== 'undefined') {
      let raf = 0;
      const ro = new ResizeObserver(() => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(applyResponsive);
      });
      ro.observe(document.documentElement);
    } else {
      window.addEventListener('resize', applyResponsive);
    }
  } catch { /* 沙箱或测试桩忽略 */ }
  applyResponsive();

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
  el('search').title = t('searchShortcut');
  el('btn-refresh').textContent = t('refresh');
  el('btn-add').textContent = t('add');
  el('connected-label').textContent = t('connected');
  el('drawer-title').textContent = t('connectedTitle');
  el('drawer-close').textContent = t('close');
  el('list-title').textContent = t('catalog');
  el('loading').textContent = t('loadingText');
  const layoutSwitch = el('layout-switch');
  if (layoutSwitch) {
    layoutSwitch.setAttribute('aria-label', t('viewGroup'));
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
