/**
 * 凭据申请指引。
 *
 * 目录（尤其远程 registry）只能声明「需要什么凭据」，常常没有 `credentialHelpUrl`。
 * 结果是用户点「连接」后只看到一句「需要凭据」，仍不知道该去哪里拿 Key——这正是
 * 「连接器连不上」最常见的真实卡点。
 *
 * 本模块为**已知**厂商补上官方申请页面，作为目录缺省时的兜底。原则：
 *   1. 只收录有稳定官方文档页的服务，绝不猜 URL；
 *   2. 目录里已声明 `credentialHelpUrl` / `homepage` 时一律以目录为准；
 *   3. 只输出文案与链接，绝不涉及任何凭据值。
 */

import { DEFAULT_LOCALE, createTranslator } from './i18n/index.js';

const tZh = createTranslator(DEFAULT_LOCALE);

/**
 * connectorId → 申请指引。
 *
 * `url` 必须是该服务的官方凭据管理/申请页；`label` 是给面板按钮用的动作文案。
 */
const CREDENTIAL_GUIDES = Object.freeze({
  github: {
    url: 'https://github.com/settings/tokens',
    label: '去 GitHub 创建 Personal Access Token',
    note: '推荐 fine-grained token：只勾选需要的仓库与权限（如 Contents / Issues / Pull requests 读权限）。',
  },
  amap: {
    url: 'https://console.amap.com/dev/key/app',
    label: '去高德开放平台创建 Web 服务 Key',
    note: '应用类型请选「Web服务」；Key 创建后可直接用于地点搜索、路线规划、天气等接口。',
  },
  'google-maps': {
    url: 'https://console.cloud.google.com/google/maps-apis/credentials',
    label: '去 Google Cloud 创建 API Key',
    note: '需要在同一项目里启用对应的 Maps API，否则调用会返回 REQUEST_DENIED。',
  },
  slack: {
    url: 'https://api.slack.com/apps',
    label: '在 Slack 创建 App 获取 Token',
    note: '通常需要 Bot User OAuth Token（xoxb- 开头），并为其添加所需 scope。',
  },
  notion: {
    url: 'https://www.notion.so/my-integrations',
    label: '在 Notion 创建 Integration',
    note: '创建后记得把目标页面/数据库「分享」给该 Integration，否则会返回 404。',
  },
  figma: {
    url: 'https://www.figma.com/developers/api#access-tokens',
    label: '在 Figma 生成访问令牌',
    note: '个人访问令牌（Personal access token）即可读取文件与评论。',
  },
  linear: {
    url: 'https://linear.app/settings/api',
    label: '在 Linear 创建 API Key',
    note: '个人 API Key 继承创建者的可见范围。',
  },
  stripe: {
    url: 'https://dashboard.stripe.com/apikeys',
    label: '去 Stripe 获取 API Key',
    note: '测试环境用 sk_test_，生产用 sk_live_；切勿把 live key 提交进仓库。',
  },
  jira: {
    url: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    label: '创建 Atlassian API Token',
    note: 'Jira/Confluence 通常配合邮箱做 Basic 认证，或使用 Atlassian 的 API token。',
  },
});

/**
 * 解析某个连接器的申请指引。
 *
 * 优先级：目录声明的 `credentialHelpUrl` > 目录 `homepage` > 内置已知指引。
 * 都没有时返回 `undefined`，由调用方决定如何提示，绝不给假链接。
 *
 * @param {{id:string, homepage?:string, auth?:{credentialHelpUrl?:string, credentialHelpLabel?:string, credentialDescription?:string}}} connector
 * @param {{t?:Function}} [options]
 * @returns {{url:string, label:string, note:string, source:'catalog'|'builtin'}|undefined}
 */
export function resolveCredentialGuide(connector, { t = tZh } = {}) {
  if (!connector) return undefined;
  const auth = connector.auth ?? {};
  const declared = typeof auth.credentialHelpUrl === 'string' ? auth.credentialHelpUrl.trim() : '';
  if (declared) {
    return {
      url: declared,
      label: auth.credentialHelpLabel || t('查看申请说明'),
      note: auth.credentialDescription || '',
      source: 'catalog',
    };
  }
  const builtin = CREDENTIAL_GUIDES[connector.id];
  if (builtin) {
    return {
      url: builtin.url,
      label: auth.credentialHelpLabel || builtin.label,
      note: auth.credentialDescription || builtin.note,
      source: 'builtin',
    };
  }
  const homepage = typeof connector.homepage === 'string' ? connector.homepage.trim() : '';
  if (homepage) {
    return {
      url: homepage,
      label: auth.credentialHelpLabel || t('打开服务主页'),
      note: auth.credentialDescription || '',
      source: 'catalog',
    };
  }
  return undefined;
}

/** 内置指引覆盖的连接器 id（供文档与测试使用）。 */
export function guidedConnectorIds() {
  return Object.keys(CREDENTIAL_GUIDES);
}
