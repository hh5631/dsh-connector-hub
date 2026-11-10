import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCredentialError, credentialErrorText, probeBusinessReadiness,
  pickProbeTool, buildProbeArguments, responseText,
} from '../lib/deep-health.js';
import { extractTokenExpiry, extractTokenResources } from '../lib/oauth.js';
import { buildHealthSummary, diagnosticForRecord } from '../lib/diagnostics.js';

const record = {
  key: 'seedance-seedance',
  connectorId: 'seedance',
  serverName: 'seedance',
  serverKey: 'seedance',
  transport: 'streamable-http',
  url: 'https://seedance.mcp.acedata.cloud/mcp',
  auth: { mode: 'bearer', bearerToken: 'expired-token' },
};

const TOOLS = [
  { name: 'seedance_list_models', inputSchema: { properties: {}, type: 'object' } },
  { name: 'seedance_generate_video', inputSchema: { properties: { prompt: { type: 'string' } }, required: ['prompt'] } },
  { name: 'seedance_get_task', inputSchema: { properties: { task_id: { type: 'string' } }, required: ['task_id'] } },
];

function makeBody(text) {
  const bytes = new TextEncoder().encode(text);
  return {
    body: {
      getReader() {
        let done = false;
        return {
          read: async () => done ? { done: true, value: undefined } : (done = true, { done: false, value: bytes }),
          releaseLock() {}, cancel: async () => {},
        };
      },
    },
  };
}

/** 模拟两阶段探针：tools/list → tools/call。 */
function mockFetch({ status = 200, listPayload, callPayload, callText } = {}) {
  let step = 0;
  return async () => {
    step += 1;
    const isList = step === 1;
    const payload = isList
      ? (listPayload ?? { jsonrpc: '2.0', id: 900000, result: { tools: TOOLS } })
      : callPayload;
    const text = isList ? JSON.stringify(payload) : (callText ?? JSON.stringify(payload ?? {}));
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Map([['content-type', 'application/json']]),
      ...makeBody(text),
    };
  };
}

/* ── 凭据错误分类 ───────────────────────────────────────────── */

test('classifyCredentialError: HTTP 401/403 直接判定凭据失效', () => {
  assert.equal(classifyCredentialError(new Error('boom'), { httpStatus: 401 }).kind, 'credential-invalid');
  assert.equal(classifyCredentialError(new Error('boom'), { httpStatus: 403 }).kind, 'credential-invalid');
});

test('classifyCredentialError: 上游典型文案 "The token is invalid"', () => {
  assert.equal(classifyCredentialError('Error: The token is invalid, please make sure your token is correct.').kind, 'credential-invalid');
  assert.equal(classifyCredentialError({ message: 'invalid api key' }).kind, 'credential-invalid');
  assert.equal(classifyCredentialError({ message: 'unauthorized' }).kind, 'credential-invalid');
  assert.equal(classifyCredentialError({ message: '令牌无效' }).kind, 'credential-invalid');
});

test('classifyCredentialError: 普通错误/良性错误不误判', () => {
  assert.equal(classifyCredentialError(new Error('ECONNRESET')).kind, 'unknown');
  assert.equal(classifyCredentialError({ message: 'Tool not found' }).kind, 'unknown');
  assert.equal(classifyCredentialError('missing required parameter task_id').kind, 'unknown');
  assert.equal(credentialErrorText(null), '');
});

/* ── 探针工具选择（零副作用的核心保障） ─────────────────────── */

test('pickProbeTool: 只选只读查询类，排除 generate 等动作类', () => {
  const picked = pickProbeTool(TOOLS);
  assert.equal(picked.name, 'seedance_get_task');
  assert.ok(!/generate|create|delete/.test(picked.name));
});

test('pickProbeTool: 全是写工具时返回 null（不敢乱调）', () => {
  assert.equal(pickProbeTool([{ name: 'generate_video' }, { name: 'delete_task' }]), null);
  assert.equal(pickProbeTool([]), null);
});

test('buildProbeArguments: 只填必填项的占位值', () => {
  const args = buildProbeArguments(TOOLS[2]);
  assert.deepEqual(args, { task_id: '__connector_hub_probe__' });
  assert.deepEqual(buildProbeArguments({ inputSchema: { properties: {}, required: [] } }), {});
});

test('responseText: 解析非标准的 result.content[].text', () => {
  const payload = { jsonrpc: '2.0', result: { content: [{ type: 'text', text: 'The token is invalid' }], isError: true } };
  assert.match(responseText(payload, ''), /token is invalid/);
});

/* ── 深度业务探针 ───────────────────────────────────────────── */

test('probeBusinessReadiness: result.content 里的 token invalid → credential-invalid', async () => {
  const result = await probeBusinessReadiness(record, new Map(), {
    fetchImpl: mockFetch({
      callPayload: { jsonrpc: '2.0', id: 900001, result: { content: [{ type: 'text', text: 'Error executing tool seedance_get_task: The token is invalid, please make sure your token is correct.' }], isError: true } },
    }),
  });
  assert.equal(result.readiness, 'credential-invalid');
  assert.equal(result.code, 'business-auth');
  assert.equal(result.probeTool, 'seedance_get_task');
});

test('probeBusinessReadiness: JSON-RPC error 里 token invalid → credential-invalid', async () => {
  const result = await probeBusinessReadiness(record, new Map(), {
    fetchImpl: mockFetch({ callPayload: { jsonrpc: '2.0', id: 900001, error: { code: -32000, message: 'invalid api key' } } }),
  });
  assert.equal(result.readiness, 'credential-invalid');
});

test('probeBusinessReadiness: HTTP 401（tools/list 阶段）→ credential-invalid', async () => {
  const result = await probeBusinessReadiness(record, new Map(), { fetchImpl: mockFetch({ status: 401, listPayload: { error: { message: 'Unauthorized' } } }) });
  assert.equal(result.readiness, 'credential-invalid');
  assert.equal(result.httpStatus, 401);
});

test('probeBusinessReadiness: 正常业务返回 → verified', async () => {
  const result = await probeBusinessReadiness(record, new Map(), {
    fetchImpl: mockFetch({ callPayload: { jsonrpc: '2.0', id: 900001, result: { content: [{ type: 'text', text: 'Available Models: ...' }] } } }),
  });
  assert.equal(result.readiness, 'verified');
  assert.equal(result.code, 'business-ok');
});

test('probeBusinessReadiness: 参数缺失（良性错误）→ verified（鉴权已放行）', async () => {
  const result = await probeBusinessReadiness(record, new Map(), {
    fetchImpl: mockFetch({ callPayload: { jsonrpc: '2.0', id: 900001, error: { code: -32602, message: 'missing required parameter task_id' } } }),
  });
  assert.equal(result.readiness, 'verified');
});

test('probeBusinessReadiness: 网络失败 → unknown（不把成功降级）', async () => {
  const result = await probeBusinessReadiness(record, new Map(), {
    fetchImpl: async () => { throw new Error('ECONNRESET'); },
  });
  assert.equal(result.readiness, 'unknown');
  assert.equal(result.code, 'probe-failed');
});

test('probeBusinessReadiness: 无安全工具 → unknown', async () => {
  const result = await probeBusinessReadiness(record, new Map(), {
    fetchImpl: mockFetch({ listPayload: { jsonrpc: '2.0', id: 900000, result: { tools: [{ name: 'generate_video' }] } } }),
  });
  assert.equal(result.readiness, 'unknown');
  assert.equal(result.code, 'no-safe-tool');
});

test('probeBusinessReadiness: stdio 连接跳过探针', async () => {
  const result = await probeBusinessReadiness({ ...record, transport: 'stdio' }, new Map(), { fetchImpl: mockFetch() });
  assert.equal(result.readiness, 'unknown');
  assert.equal(result.code, 'not-applicable');
});

test('probeBusinessReadiness: 绝不调用 generate 类工具', async () => {
  const called = [];
  await probeBusinessReadiness(record, new Map(), {
    fetchImpl: async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.method === 'tools/call') called.push(body.params.name);
      return mockFetch({ callPayload: { jsonrpc: '2.0', id: 900001, result: { content: [{ type: 'text', text: 'ok' }] } } })();
    },
  });
  assert.deepEqual(called, ['seedance_get_task']);
});

/* ── JWT 过期提取 ───────────────────────────────────────────── */

test('extractTokenExpiry: 正常 JWT 返回毫秒时间戳', () => {
  const payload = Buffer.from(JSON.stringify({ exp: 1_800_000_000, resource: ['x'] })).toString('base64url');
  const token = `aaa.${payload}.bbb`;
  assert.equal(extractTokenExpiry(token), 1_800_000_000_000);
  assert.deepEqual(extractTokenResources(token), ['x']);
});

test('extractTokenExpiry: 非 JWT / 无 exp / 非法值一律 null，不抛异常', () => {
  assert.equal(extractTokenExpiry('not-a-jwt'), null);
  assert.equal(extractTokenExpiry(null), null);
  assert.equal(extractTokenExpiry(`aaa.${Buffer.from('{}').toString('base64url')}.bbb`), null);
  assert.equal(extractTokenExpiry(`aaa.${Buffer.from('{"exp":"oops"}').toString('base64url')}.bbb`), null);
});

/* ── 健康摘要兼容扩展字段 ───────────────────────────────────── */

test('buildHealthSummary: 凭据失效结果产出 reauth 诊断 + 修复动作', () => {
  const results = [{
    ok: false, kind: 'auth', code: 'credential-invalid', serverKey: 'seedance', serverName: 'seedance',
    message: '握手正常，但凭据已失效',
    remediation: { kind: 'reconfigure-credentials', api: 'configure', label: '重新配置凭据', connectionKey: 'x', connectorId: 'seedance' },
  }];
  const summary = buildHealthSummary({ connectorId: 'seedance', records: [record], results });
  assert.equal(summary.connectionState, 'reauth');
  assert.equal(summary.diagnostic.code, 'credential-invalid');
  assert.equal(diagnosticForRecord(summary, summary.results[0]).code, 'credential-invalid');
});
