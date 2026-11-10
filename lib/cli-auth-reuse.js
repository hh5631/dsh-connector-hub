/**
 * 本机 CLI 登录态复用。
 *
 * 很多服务已经把 OAuth 授权流程做进了官方 CLI（GitHub CLI、gh、gitlab、az 等）。
 * 用户机器上这些 CLI 往往已经登录过，token 就躺在 keyring 或 CLI 自己的配置里。
 * 与其让用户再手工创一个 PAT，不如直接复用这份已有的授权——语义上它**就是**
 * 用户已经同意过的 OAuth token，只是由 CLI 代为保管。
 *
 * 安全边界（重要）：
 *   1. 只用只读命令（如 `gh auth token`）读取 token，绝不写改 CLI 配置；
 *   2. token 只在内存中传给连接记录，绝不写日志、绝不进返回值；
 *   3. 只探测**白名单**内的 CLI，不做任意命令执行；
 *   4. 探测失败一律降级为「不可用」，不抛异常打断连接流程。
 *
 * 之所以单独成模块而不是塞进 cli-providers.js：后者是「把 CLI 当 MCP 工具桥」，
 * 与「借用 CLI 的凭据」是两件不同的事，混在一起会让两边的安全假设互相污染。
 */
import { spawn } from 'node:child_process';

import { DEFAULT_LOCALE, createTranslator } from './i18n/index.js';

const tZh = createTranslator(DEFAULT_LOCALE);

/** 单个 CLI 探测的总超时；CLI 卡住不能拖死整个连接流程。 */
const PROBE_TIMEOUT_MS = 8_000;

/** token 合法性的粗略上限，避免异常输出被当作凭据写入存储。 */
const MAX_TOKEN_LENGTH = 4096;

/**
 * 可复用的 CLI 提供方白名单。
 *
 * `readToken` 返回 argv 数组，由 `spawn` 直接执行，**不经过 shell**，
 * 因此不存在命令注入面。`acceptedPrefixes` 用于粗筛 token 形状：
 * 目的不是严格校验，而是在 CLI 输出异常（比如打印了帮助文本）时尽早放弃。
 */
const CLI_AUTH_PROVIDERS = Object.freeze({
  gh: {
    label: 'GitHub CLI (gh)',
    bin: 'gh',
    readToken: ['auth', 'token'],
    statusArgs: ['auth', 'status'],
    acceptedPrefixes: ['gho_', 'ghp_', 'ghu_', 'ghs_', 'github_pat_'],
    connectorIds: ['github'],
  },
  glab: {
    label: 'GitLab CLI (glab)',
    bin: 'glab',
    readToken: ['auth', 'status', '--show-token'],
    statusArgs: ['auth', 'status'],
    acceptedPrefixes: ['glpat-', 'gloas-'],
    connectorIds: ['gitlab'],
  },
  'azure-devops': {
    label: 'Azure CLI (az)',
    bin: 'az',
    readToken: ['account', 'get-access-token', '--query', 'accessToken', '--output', 'tsv'],
    statusArgs: ['account', 'show'],
    acceptedPrefixes: [],
    connectorIds: ['azure-devops'],
  },
});

/** 执行一个只读命令，返回 stdout（已 trim）；超时/失败返回 null。 */
function runReadOnly(bin, args, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    let child;
    try {
      child = spawn(bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        // 不用 shell：argv 直接传递，避免任何注入面。
        shell: false,
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }

    const chunks = [];
    let size = 0;
    child.stdout?.on('data', (chunk) => {
      // 防御异常输出：只保留有界前缀，绝不无限累积。
      if (size >= MAX_TOKEN_LENGTH * 2) return;
      chunks.push(chunk);
      size += chunk.length;
    });
    child.stderr?.on('data', () => {});
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      if (code !== 0) return finish(null);
      finish(Buffer.concat(chunks).toString('utf8').trim());
    });

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 进程可能已退出 */ }
      finish(null);
    }, timeoutMs);
    timer.unref?.();
  });
}

/** 粗筛 token 形状；没有声明前缀的提供方只做基础长度/空白检查。 */
function looksLikeToken(value, acceptedPrefixes) {
  if (typeof value !== 'string') return false;
  const token = value.trim();
  if (token === '' || token.length > MAX_TOKEN_LENGTH) return false;
  if (/\s/.test(token)) return false;
  if (acceptedPrefixes.length === 0) return token.length >= 16;
  return acceptedPrefixes.some((prefix) => token.startsWith(prefix));
}

/** 从 glab 的 `auth status --show-token` 人类可读输出里抠出 token。 */
function extractTokenFromStatusOutput(output, acceptedPrefixes) {
  for (const match of String(output).matchAll(/([A-Za-z0-9_-]{20,})/g)) {
    if (looksLikeToken(match[1], acceptedPrefixes)) return match[1];
  }
  return null;
}

/**
 * 检测单个 CLI 是否已登录，并在可用时取回 token。
 *
 * @param {string} providerId 白名单内的 provider id
 * @returns {Promise<{available:boolean, providerId:string, label:string,
 *   connectorIds:string[], token?:string, reason?:string}>}
 */
export async function probeCliAuth(providerId) {
  const provider = CLI_AUTH_PROVIDERS[providerId];
  if (!provider) {
    return { available: false, providerId, label: providerId, connectorIds: [], reason: tZh('未知的 CLI 提供方') };
  }
  const base = { providerId, label: provider.label, connectorIds: [...provider.connectorIds] };

  const status = await runReadOnly(provider.bin, provider.statusArgs);
  if (status === null) {
    return { ...base, available: false, reason: tZh('未安装或未登录') };
  }

  const raw = await runReadOnly(provider.bin, provider.readToken);
  if (raw === null) return { ...base, available: false, reason: tZh('无法读取已登录凭据') };

  // gh 的 `auth token` 直接输出裸 token；glab 则嵌在人类可读文本里。
  const token = looksLikeToken(raw, provider.acceptedPrefixes)
    ? raw.trim()
    : extractTokenFromStatusOutput(raw, provider.acceptedPrefixes);
  if (!token) return { ...base, available: false, reason: tZh('未取到可用凭据') };

  return { ...base, available: true, token };
}

/**
 * 探测所有白名单 CLI，返回可用项。
 *
 * `includeToken: false` 用于面板展示：只报告「哪个 CLI 已登录」，
 * 不把 token 交给前端，避免凭据在浏览器可读的响应里流转。
 */
export async function discoverCliAuth({ includeToken = false } = {}) {
  const results = await Promise.all(Object.keys(CLI_AUTH_PROVIDERS).map((id) => probeCliAuth(id)));
  return results.map((item) => (includeToken
    ? item
    : { providerId: item.providerId, label: item.label, connectorIds: item.connectorIds, available: item.available, reason: item.reason }));
}

/** 按连接器 id 找到可复用的 CLI 登录态（含 token），找不到返回 null。 */
export async function findCliAuthForConnector(connectorId, { preferredProvider } = {}) {
  if (!connectorId) return null;
  const candidates = preferredProvider
    ? [preferredProvider, ...Object.keys(CLI_AUTH_PROVIDERS).filter((id) => id !== preferredProvider)]
    : Object.keys(CLI_AUTH_PROVIDERS);
  for (const id of candidates) {
    const provider = CLI_AUTH_PROVIDERS[id];
    if (!provider || !provider.connectorIds.includes(connectorId)) continue;
    const probed = await probeCliAuth(id);
    if (probed.available && probed.token) return probed;
  }
  return null;
}

/** 白名单提供方清单（供工具描述与面板展示）；不含任何凭据。 */
export function listCliAuthProviders() {
  return Object.entries(CLI_AUTH_PROVIDERS).map(([id, provider]) => ({
    providerId: id,
    label: provider.label,
    connectorIds: [...provider.connectorIds],
  }));
}
