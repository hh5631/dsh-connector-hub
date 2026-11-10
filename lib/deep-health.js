/**
 * 深度健康探测：区分「握手正常 / 业务可用 / 凭据失效」三态。
 *
 * 背景（Hub 版核心优化）：
 *   原版健康检查只发一次 MCP `initialize`。部分网关（典型如 AceDataCloud 的
 *   Seedance / Kling）在握手层**不校验** Bearer Token，直到真实业务方法才回
 *   "The token is invalid"。于是「已连接 / ok」是假阳性。
 *
 * 探针策略（经真实网关验证后修正）：
 *   不能调用虚构工具——网关对虚构工具直接回 "Unknown tool"，也不校验 token。
 *   必须先 `tools/list` 拿到真实工具清单，再挑一个**只读查询类**工具，用最小
 *   合法参数发起一次调用，观察服务端响应里的错误文本。
 *
 *   选择规则（保证零副作用、零计费）：
 *     - 只选名字含 get/list/find/search/status/query/read/describe/info 的工具；
 *     - 排除 generate/create/delete/update/extend/send/upload/submit/run/pay/buy 等动作类；
 *     - 优先选「查询任务状态」类（get_task / status），它们只读；
 *     - 参数按 inputSchema 的必填项填占位值（字符串用 "__probe__"，数字用 0）。
 *
 * 三态：
 *   - `credential-invalid`：401/403、token/key invalid、unauthorized、过期/无权限
 *   - `verified`：业务调用正常返回（含「参数校验错误」——说明鉴权已放行）
 *   - `unknown`：网络失败、超时、无法归类（绝不把成功降级为失败）
 *
 * 安全性：独立超时、64 KiB 响应上限、URL 安全校验、不跟随到不可信地址；
 * 结果只存内存、不落库、不进 SSE 事件流（SSE 契约禁带错误/凭据）。
 */

import { MCP_PROTOCOL_VERSION } from './constants.js';
import { authHeaders } from './mcp-provision.js';
import { assertSafeUrl } from './util.js';

const MAX_RESPONSE_BYTES = 64 * 1024;
const PROBE_ID = 900_001;
const LIST_ID = 900_000;

/** 凭据失效特征。命中即判定 credential-invalid，不重试、不等待。 */
const CREDENTIAL_INVALID_RE =
  /(?:invalid|expired)[ _-]?(?:api[ _-]?key|token|credential|access[ _-]?token)|(?:api[ _-]?key|token|credential|access[ _-]?token)[^a-z]{0,20}(?:invalid|expired|missing|not[ _-]?valid)|unauthori[sz]ed|unauthenticated|forbidden|access[ _-]?denied|permission[ _-]?denied|未授权|无权访问|令牌无效|密钥无效|凭据失效|鉴权失败|token is invalid|please make sure your token|sign in again|please log ?in/i;

/** 只读查询类工具（白名单语义：只有这些允许作为探针）。 */
const READ_ONLY_HINT = /(?:^|[_-])(?:get|list|find|search|status|query|read|describe|info|fetch|check|show|browse|lookup)(?:[_-]|$)|^(?:get|list|find|search|status|query|read|describe|info|fetch|check|show|browse|lookup)/i;
/** 动作类工具（黑名单，一票否决，避免任何计费/写操作）。 */
const SIDE_EFFECT_HINT = /(?:^|[_-])(?:generate|create|delete|remove|update|extend|send|upload|submit|run|execute|pay|buy|order|publish|write|set|add|clone|fork|merge|cancel|restart|install|train|sync|export|import|apply|commit|push|post)(?:[_-]|$)|^(?:generate|create|delete|remove|update|extend|send|upload|submit|run|execute|pay|buy|order|publish|write|set|add)/i;

/** "工具/方法不存在" 或参数校验错误：说明鉴权层已放行。 */
const BENIGN_ERROR_RE =
  /(?:method|tool|function)[^a-z]{0,12}(?:not[ _-]?found|unknown|unsupported|does[ _-]?not[ _-]?exist)|unknown[ _-]?(?:method|tool)|invalid[ _-]?(?:method|params|parameter|argument|request)|missing[ _-]?(?:required[ _-]?)?(?:parameter|argument|field)|required[ _-]?(?:parameter|argument|field)|-?3260[12]|未找到|不存在|参数错误|缺少参数/i;

/** 把任意错误对象/Payload/文本归一为可判定的字符串。 */
export function credentialErrorText(error) {
  if (error == null) return '';
  if (typeof error === 'string') return error.slice(0, 1024);
  if (typeof error === 'object') {
    const parts = [error.message, error.description, error.code, error.status, error.httpStatus];
    let cur = error;
    for (let i = 0; cur && i < 4; i += 1) {
      parts.push(cur?.message, cur?.code, cur?.name);
      cur = cur?.cause;
    }
    return parts.filter((p) => p !== undefined && p !== null).join(' ').slice(0, 2048);
  }
  return String(error).slice(0, 1024);
}

/**
 * 统一的凭据错误分类器（供 healthCheck / repairCredentials / UI 共用）。
 * @param {unknown} error 错误对象、JSON-RPC payload、result.content 文本或字符串
 * @param {{ httpStatus?: number }} [options]
 * @returns {{ kind: 'credential-invalid'|'unknown', text: string }}
 */
export function classifyCredentialError(error, { httpStatus } = {}) {
  const text = credentialErrorText(error);
  if (httpStatus === 401 || httpStatus === 403 || /\bHTTP[ _-]?(?:401|403)\b/i.test(text)) {
    return { kind: 'credential-invalid', text };
  }
  if (CREDENTIAL_INVALID_RE.test(text)) return { kind: 'credential-invalid', text };
  return { kind: 'unknown', text };
}

function parsePayload(text, contentType) {
  if ((contentType || '').toLowerCase().includes('text/event-stream')) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      try { return JSON.parse(line.slice(5).trim()); } catch { /* 跳过非 JSON 事件 */ }
    }
    return undefined;
  }
  try { return JSON.parse(text); } catch { return undefined; }
}

async function readLimited(response, maxBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel().catch(() => {}); return ''; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

/** 从 tools/list 里挑一个安全的只读探针工具。 */
export function pickProbeTool(tools) {
  if (!Array.isArray(tools)) return null;
  const safe = tools.filter((tool) => {
    const name = String(tool?.name ?? '');
    if (!name || SIDE_EFFECT_HINT.test(name)) return false;
    return READ_ONLY_HINT.test(name);
  });
  if (safe.length === 0) return null;
  // 优先「查询任务/状态」类：它们只读、参数少、不会创建资源。
  const preferred = safe.find((t) => /(?:task|status|state|job|result)/i.test(t.name));
  return preferred ?? safe[0];
}

/** 按 inputSchema 的必填项构造最小占位参数（不会产生真实业务数据）。 */
export function buildProbeArguments(tool) {
  const schema = tool?.inputSchema ?? {};
  const props = schema.properties ?? {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const args = {};
  for (const key of required) {
    const type = props[key]?.type;
    args[key] = type === 'number' || type === 'integer' ? 0
      : type === 'boolean' ? false
        : type === 'array' ? []
          : '__connector_hub_probe__';
  }
  return args;
}

/** 把 JSON-RPC 响应（含非标准的 result.content）里可判定的文本抽出来。 */
export function responseText(payload, rawText) {
  const parts = [];
  if (payload?.error) parts.push(String(payload.error.message ?? payload.error.description ?? ''));
  const content = payload?.result?.content;
  if (Array.isArray(content)) {
    for (const item of content) if (typeof item?.text === 'string') parts.push(item.text);
  }
  if (payload?.result && !Array.isArray(content)) {
    parts.push(typeof payload.result === 'string' ? payload.result : JSON.stringify(payload.result));
  }
  parts.push(String(rawText ?? '').slice(0, 2048));
  return parts.join(' ').replace(/\s+/g, ' ').slice(0, 4096);
}

async function postJson(url, body, { headers, signal, fetchImpl }) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
    signal,
    redirect: 'follow',
  });
  const text = await readLimited(response, MAX_RESPONSE_BYTES);
  return { response, text, payload: parsePayload(text, response.headers.get('content-type') ?? '') };
}

/**
 * 执行一次业务级探针。
 *
 * @param {object} record 连接记录（需含 url / auth / transport）
 * @param {Map} grants OAuth grant 集合
 * @param {{ timeoutMs?: number, fetchImpl?: Function, tools?: object[] }} [options]
 *   `tools` 可由调用方传入已缓存的 tools/list 结果，省掉一次往返。
 * @returns {Promise<{readiness, code, message, httpStatus?, checkedAt, probeTool?}>}
 */
export async function probeBusinessReadiness(record, grants = new Map(), {
  timeoutMs = 8_000,
  fetchImpl = fetch,
  tools,
} = {}) {
  const checkedAt = Date.now();
  const base = { checkedAt };
  if (!record || record.transport !== 'streamable-http' || !record.url) {
    return { ...base, readiness: 'unknown', code: 'not-applicable', message: '非 HTTP 传输，跳过业务探针' };
  }
  try { assertSafeUrl(record.url); } catch {
    return { ...base, readiness: 'unknown', code: 'unsafe-url', message: '端点不安全，跳过业务探针' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const headers = authHeaders(record, grants);
  try {
    let toolList = Array.isArray(tools) ? tools : null;
    if (!toolList) {
      const listed = await postJson(record.url, {
        jsonrpc: '2.0', id: LIST_ID, method: 'tools/list', params: {},
      }, { headers, signal: controller.signal, fetchImpl });
      if (listed.response.status === 401 || listed.response.status === 403) {
        return { ...base, readiness: 'credential-invalid', code: 'http-auth', httpStatus: listed.response.status, message: `凭据无效或权限不足（HTTP ${listed.response.status}）` };
      }
      if (!listed.response.ok) {
        return { ...base, readiness: 'unknown', code: 'tool-list-http', httpStatus: listed.response.status, message: `工具清单返回 HTTP ${listed.response.status}` };
      }
      toolList = listed.payload?.result?.tools;
      const listText = responseText(listed.payload, listed.text);
      if (classifyCredentialError(listText).kind === 'credential-invalid') {
        return { ...base, readiness: 'credential-invalid', code: 'tool-list-auth', message: `凭据无效：${listText.split(/[\n。]/)[0].slice(0, 120)}` };
      }
    }

    const probeTool = pickProbeTool(toolList);
    if (!probeTool) {
      // 没有安全的只读工具：不敢乱调，保持未知而不是误报成功。
      return { ...base, readiness: 'unknown', code: 'no-safe-tool', message: '该 Server 没有可安全探测的只读工具，保持未知' };
    }
    const called = await postJson(record.url, {
      jsonrpc: '2.0', id: PROBE_ID, method: 'tools/call',
      params: { name: probeTool.name, arguments: buildProbeArguments(probeTool) },
    }, { headers, signal: controller.signal, fetchImpl });

    if (called.response.status === 401 || called.response.status === 403) {
      return { ...base, readiness: 'credential-invalid', code: 'http-auth', httpStatus: called.response.status, message: `凭据无效或权限不足（HTTP ${called.response.status}）`, probeTool: probeTool.name };
    }
    if (!called.response.ok) {
      const text = responseText(called.payload, called.text);
      const classified = classifyCredentialError(text, { httpStatus: called.response.status });
      return {
        ...base,
        readiness: classified.kind === 'credential-invalid' ? 'credential-invalid' : 'unknown',
        code: classified.kind === 'credential-invalid' ? 'http-auth-text' : 'http-error',
        httpStatus: called.response.status,
        message: classified.kind === 'credential-invalid' ? `凭据无效：${text.split(/[\n。]/)[0].slice(0, 120)}` : `服务返回 HTTP ${called.response.status}`,
        probeTool: probeTool.name,
      };
    }

    const text = responseText(called.payload, called.text);
    // 1) 凭据失效优先判定（覆盖网关把错误塞进 result.content 的非标准行为）
    if (classifyCredentialError(text, { httpStatus: called.response.status }).kind === 'credential-invalid') {
      return { ...base, readiness: 'credential-invalid', code: 'business-auth', message: `凭据无效：${text.split(/[\n。]/)[0].slice(0, 120)}`, probeTool: probeTool.name };
    }
    // 2) 参数/方法不存在等良性错误：鉴权已放行，业务通道可用
    if (BENIGN_ERROR_RE.test(text) || called.payload?.error) {
      return { ...base, readiness: 'verified', code: 'verified-by-benign-error', message: '鉴权已通过，业务通道可用', probeTool: probeTool.name };
    }
    // 3) 正常返回：视为业务可用
    if (called.payload?.result) {
      return { ...base, readiness: 'verified', code: 'business-ok', message: '业务调用正常返回', probeTool: probeTool.name };
    }
    return { ...base, readiness: 'unknown', code: 'indeterminate', message: '业务探针未返回可判定结果，保持未知', probeTool: probeTool.name };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...base, readiness: 'unknown', code: 'probe-failed', message: `业务探针未完成：${message.slice(0, 120)}` };
  } finally {
    clearTimeout(timer);
  }
}
