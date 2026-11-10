/**
 * 通道一：OAuth 一键授权。
 * 支持三种客户端来源与两种用户交互方式：
 *   - 授权码 + PKCE + DCR（默认，服务支持动态注册时）
 *   - 授权码 + PKCE + 预置 client_id/secret（服务不支持 DCR 时由用户自填）
 *   - 设备码流程 RFC 8628（无 DCR 但也无需 redirect_uri 白名单时）
 * 完成全流程并把结果交给 index.js 落库、挂载 mcp-client 条目、调度刷新。
 */
import {
  discoverProtectedResource,
  discoverServerMetadata,
  registerClient,
  pkcePair,
  generateState,
  buildAuthorizeUrl,
  exchangeCode,
  extractTokenResources,
  requestDeviceCode,
  pollDeviceToken,
} from '../oauth.js';
import { startCallbackServer } from '../callback-server.js';
import { openBrowser } from '../util.js';
import { DEFAULT_LOCALE, createTranslator } from '../i18n/index.js';

/** 缺省译文：中文（既有调用点与测试无需改动）。 */
const tZh = createTranslator(DEFAULT_LOCALE);

/** 阶段枚举 → 中文标签（msgid）。枚举值本身不翻译，只在 `describeOAuthAuthorizationError` 里经 `t()` 输出。 */
const OAUTH_STAGE_LABELS = Object.freeze({
  unknown: 'OAuth 授权',
  'resource-discovery': '受保护资源发现',
  'server-metadata': 'OAuth 服务发现',
  'callback-listener': '本机回调监听',
  'client-registration': 'OAuth 客户端注册',
  'authorization-callback': '浏览器授权回调',
  'token-exchange': 'OAuth Token 换取',
  'device-authorization': '设备码申请',
  'device-token-poll': '设备码授权等待',
});

async function atOAuthStage(stage, action) {
  try {
    return await action();
  } catch (error) {
    if (error && typeof error === 'object' && !error.oauthStage) {
      error.oauthStage = stage;
      error.oauthStageLabel = OAUTH_STAGE_LABELS[stage] ?? stage;
    }
    throw error;
  }
}

function stagedError(stage, message, code) {
  const error = new Error(message);
  error.oauthStage = stage;
  error.oauthStageLabel = OAUTH_STAGE_LABELS[stage] ?? stage;
  if (code) error.code = code;
  return error;
}

/** 把 OAuth 底层异常收敛为可操作、不泄露响应体的用户诊断。 */
export function describeOAuthAuthorizationError(error, { t = tZh } = {}) {
  const stage = error?.oauthStage ?? 'unknown';
  // 标签在抛出时记录为 msgid，因此这里按当前语言渲染；外部自带的标签也能安全过一遍 `t()`。
  const stageLabel = t(error?.oauthStageLabel ?? OAUTH_STAGE_LABELS[stage] ?? OAUTH_STAGE_LABELS.unknown);
  const httpStatus = Number.isInteger(error?.httpStatus) ? error.httpStatus : undefined;
  const upstreamCode = typeof error?.code === 'string' ? error.code : undefined;
  if (stage === 'client-registration' && httpStatus === 403) {
    return {
      message: t('OAuth 客户端注册被服务商拒绝（HTTP 403），尚未进入浏览器授权。该服务可能只允许已审核客户端；请查看服务商的 MCP 客户端准入说明，或等待连接器完成官方登记。'),
      detail: {
        kind: 'oauth-client-registration-rejected',
        stage,
        stageLabel,
        code: 'oauth-dcr-forbidden',
        httpStatus,
        upstreamCode,
        // 面板据此提示「可换用自己的 OAuth App 客户端」而不是让用户卡在这里。
        recoverable: 'provide-oauth-client',
      },
    };
  }
  // 服务未提供 DCR：这是**可恢复**的配置缺口，不是终局失败。
  // 标记 recoverable 让面板弹出「填 client_id」对话框，用户补上即可继续。
  if (error?.code === 'oauth-dcr-missing') {
    return {
      message: t('该服务的 OAuth 未提供动态客户端注册（DCR）。请在你自己的账号里登记一个 OAuth App，把它的 client_id（机密客户端再加 client_secret）填入后重试授权。'),
      detail: {
        kind: 'oauth-client-registration-required',
        stage,
        stageLabel,
        code: 'oauth-dcr-missing',
        recoverable: 'provide-oauth-client',
      },
    };
  }
  const safeReason = httpStatus
    ? (upstreamCode && upstreamCode !== 'http_error' ? upstreamCode : t('服务端拒绝请求'))
    : String(error?.message ?? t('未知错误'))
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .slice(0, 240);
  return {
    message: t('{stage}失败{status}：{reason}', {
      stage: stageLabel,
      status: httpStatus ? t('（HTTP {status}）', { status: httpStatus }) : '',
      reason: safeReason,
    }),
    detail: {
      kind: 'oauth-authorization',
      stage,
      stageLabel,
      code: upstreamCode ?? 'oauth-error',
      ...(httpStatus ? { httpStatus } : {}),
    },
  };
}

/**
 * @param {object} args
 * @param {object} args.connector 归一化后的连接器描述（auth.mode = oauth2-pkce）
 * @param {object} args.config 插件配置
 * @param {{info:Function,warn:Function,error:Function}} args.logger
 * @param {AbortSignal} [args.signal]
 * @param {object} [args.clientCredentials] 预置的 OAuth 客户端凭据（跳过 DCR）
 * @param {string} [args.flow] 强制授权流程：'authorization-code' | 'device-code'
 */
export async function oauthAuthorize({ connector, config, logger, signal, clientCredentials, flow }) {
  const entryServer = connector.servers.find((server) => server.url);
  if (!entryServer) throw stagedError('resource-discovery', `connector "${connector.id}" has no HTTP OAuth resource`);

  const protectedResource = await atOAuthStage(
    'resource-discovery',
    () => discoverProtectedResource(entryServer.url, config.requestTimeoutMs),
  );
  const issuer = protectedResource.authorizationServers[0] ?? connector.auth.issuer;
  if (!issuer) throw stagedError('resource-discovery', `connector "${connector.id}" missing issuer`);

  const metadata = await atOAuthStage(
    'server-metadata',
    () => discoverServerMetadata(issuer, config.requestTimeoutMs),
  );
  const requestedAuthMethod = connector.auth.tokenEndpointAuthMethod ?? 'none';
  if (metadata.tokenEndpointAuthMethodsSupported.length > 0
      && !metadata.tokenEndpointAuthMethodsSupported.includes(requestedAuthMethod)) {
    throw stagedError('server-metadata', t('OAuth 服务不支持 token_endpoint_auth_method={method}', { method: requestedAuthMethod }));
  }

  // 流程选择：显式指定 > 有 device 端点且无 DCR 时用设备码 > 默认授权码。
  // 「无 DCR」是关键判据：没有 registration_endpoint 就无法自动登记公开客户端，
  // 而 loopback 重定向通常又要求预先登记，此时设备码是唯一无需人工登记的路。
  const resolvedFlow = flow
    ?? (metadata.deviceAuthorizationEndpoint && !metadata.registrationEndpoint ? 'device-code' : 'authorization-code');

  if (resolvedFlow === 'device-code') {
    return authorizeWithDeviceCode({
      connector, config, logger, signal, metadata, protectedResource,
      entryServer, issuer, requestedAuthMethod, clientCredentials,
    });
  }

  const callback = await atOAuthStage(
    'callback-listener',
    () => startCallbackServer({ path: '/callback', timeoutMs: config.callbackTimeoutMs, signal }),
  );
  try {
    const registration = await atOAuthStage('client-registration', () => resolveOAuthClient({
      metadata,
      connector,
      clientCredentials,
      callbackUrl: callback.url,
      requestedAuthMethod,
      config,
    }));

    const { verifier, challenge, method } = pkcePair();
    const state = generateState();
    const entryResource = protectedResource.resource ?? entryServer.url;
    const authorizeUrl = buildAuthorizeUrl(metadata, {
      clientId: registration.clientId,
      redirectUri: callback.url,
      state,
      challenge,
      challengeMethod: method,
      resource: entryResource,
      scope: connector.auth.scope,
    });

    logger.info(`opening authorization page: ${authorizeUrl}`);
    if (config.openBrowser) openBrowser(authorizeUrl, logger);
    else logger.info('openBrowser disabled — please open the URL above manually to authorize');

    const { code, state: returnedState } = await atOAuthStage(
      'authorization-callback',
      () => callback.waitForCallback(),
    );
    if (returnedState !== state) {
      const error = new Error('OAuth callback state mismatch — aborting (possible CSRF)');
      error.oauthStage = 'authorization-callback';
      error.oauthStageLabel = OAUTH_STAGE_LABELS['authorization-callback'];
      throw error;
    }

    const token = await atOAuthStage('token-exchange', () => exchangeCode(metadata.tokenEndpoint, {
      clientId: registration.clientId,
      clientSecret: registration.clientSecret,
      tokenEndpointAuthMethod: registration.tokenEndpointAuthMethod,
      code,
      redirectUri: callback.url,
      codeVerifier: verifier,
      resource: entryResource,
      scope: connector.auth.scope,
      timeoutMs: config.requestTimeoutMs,
    }));

    return finalizeAuthorization({
      connector, token, registration, issuer, entryServer, protectedResource,
    });
  } finally {
    await callback.close().catch((error) => logger?.warn(`close OAuth callback listener failed: ${error.message}`));
  }
}

/** 按 token 实际授权范围过滤 server；非 JWT / 无 resource claim 时 fallback 全部 */
function finalizeAuthorization({ connector, token, registration, issuer, entryServer, protectedResource }) {
  const grantedUrls = extractTokenResources(token.accessToken);
  let grantedKeys;
  let grantedResources;
  if (grantedUrls) {
    const granted = new Set(grantedUrls);
    const grantedServers = connector.servers.filter((s) => granted.has(s.oauthResource ?? s.url));
    grantedKeys = grantedServers.map((s) => s.serverKey);
    grantedResources = [...new Set(grantedServers.map((s) => s.oauthResource ?? s.url).filter(Boolean))];
    if (grantedKeys.length === 0) {
      grantedKeys = [entryServer.serverKey];
      grantedResources = [entryServer.url];
    }
  } else {
    grantedKeys = connector.servers.map((s) => s.serverKey);
    grantedResources = [...new Set(connector.servers.map((s) => s.oauthResource ?? s.url).filter(Boolean))];
  }
  return {
    issuer,
    clientId: registration.clientId,
    clientSecret: registration.clientSecret,
    clientSecretExpiresAt: registration.clientSecretExpiresAt,
    tokenEndpointAuthMethod: registration.tokenEndpointAuthMethod,
    clientName: registration.clientName,
    scope: connector.auth.scope,
    token,
    grantedKeys,
    grantedResources,
    entryResource: protectedResource?.resource ?? entryServer.url,
    flow: 'authorization-code',
  };
}

/**
 * 解析本连接可用的 OAuth 客户端：优先使用用户预置凭据，否则走动态注册。
 *
 * 预置凭据让「不支持 DCR」的服务也能完成标准授权码流程：用户在自己的服务里
 * 登记一个 OAuth App（redirect_uri 填 127.0.0.1 回调地址），把 client_id
 * （必要时 client_secret）交给插件，就能像 DCR 服务一样一键登录。
 */
async function resolveOAuthClient({ metadata, connector, clientCredentials, callbackUrl, requestedAuthMethod, config }) {
  if (clientCredentials?.clientId) {
    return {
      clientId: String(clientCredentials.clientId),
      clientSecret: clientCredentials.clientSecret ? String(clientCredentials.clientSecret) : undefined,
      tokenEndpointAuthMethod: clientCredentials.tokenEndpointAuthMethod ?? requestedAuthMethod,
      clientSecretExpiresAt: undefined,
      clientName: connector.auth.clientName,
    };
  }
  if (!metadata.registrationEndpoint) {
    throw stagedError(
      'client-registration',
      t('该服务的 OAuth 未提供动态客户端注册（registration_endpoint），需要你填写自有 OAuth App 的 client_id（可选 client_secret）后再授权'),
      // 显式 code：让 describeOAuthAuthorizationError 能把它归类为「可恢复」，
      // 面板据此弹出 client_id 输入框，而不是显示一条死路。
      'oauth-dcr-missing',
    );
  }
  return registerClient(metadata.registrationEndpoint, {
    clientName: connector.auth.clientName,
    redirectUris: [callbackUrl],
    scope: connector.auth.scope,
    tokenEndpointAuthMethod: requestedAuthMethod,
    timeoutMs: config.requestTimeoutMs,
  });
}

/**
 * 设备码授权：把 user_code 与验证地址交给用户，后台轮询直到完成。
 *
 * 不监听本机端口，因此不依赖 redirect_uri 白名单，是「无 DCR、无预登记应用」
 * 场景下唯一仍能纯浏览器完成的授权路径。
 */
async function authorizeWithDeviceCode({
  connector, config, logger, signal, metadata, protectedResource,
  entryServer, issuer, requestedAuthMethod, clientCredentials,
}) {
  const clientId = clientCredentials?.clientId ? String(clientCredentials.clientId) : '';
  if (!clientId) {
    throw stagedError(
      'client-registration',
      t('该服务未提供动态客户端注册，设备码授权需要先填写一个已登记的 client_id'),
    );
  }
  const device = await atOAuthStage('device-authorization', () => requestDeviceCode(
    metadata.deviceAuthorizationEndpoint,
    {
      clientId,
      clientSecret: clientCredentials?.clientSecret,
      tokenEndpointAuthMethod: clientCredentials?.tokenEndpointAuthMethod ?? requestedAuthMethod,
      scope: connector.auth.scope,
      resource: protectedResource.resource ?? entryServer.url,
      timeoutMs: config.requestTimeoutMs,
    },
  ));

  const target = device.verificationUriComplete ?? device.verificationUri;
  logger.info(`device authorization required — open ${target} and enter code ${device.userCode}`);
  if (config.openBrowser) openBrowser(target, logger);

  const token = await atOAuthStage('device-token-poll', () => pollDeviceToken(metadata.tokenEndpoint, {
    clientId,
    clientSecret: clientCredentials?.clientSecret,
    tokenEndpointAuthMethod: clientCredentials?.tokenEndpointAuthMethod ?? requestedAuthMethod,
    deviceCode: device.deviceCode,
    scope: connector.auth.scope,
    resource: protectedResource.resource ?? entryServer.url,
    interval: device.interval,
    expiresIn: device.expiresIn,
    timeoutMs: config.requestTimeoutMs,
    signal,
  }));

  const registration = {
    clientId,
    clientSecret: clientCredentials?.clientSecret,
    tokenEndpointAuthMethod: clientCredentials?.tokenEndpointAuthMethod ?? requestedAuthMethod,
    clientName: connector.auth.clientName,
  };
  return {
    ...finalizeAuthorization({ connector, token, registration, issuer, entryServer, protectedResource }),
    flow: 'device-code',
    device: { userCode: device.userCode, verificationUri: device.verificationUri, verificationUriComplete: device.verificationUriComplete },
  };
}
