/**
 * 回归：宿主 mcp-client 条目里的重连策略。
 *
 * 背景（日志实证）：多个未授权的 MCP server 会连续刷出
 *   `mcp-client(hub-qcc-history): connection failed; retrying in 500ms (attempt 1/10)`
 * 十条，一路翻倍到 4 分钟。宿主默认 reconnect = { initialDelayMs: 500,
 * maxAttempts: 10 }，对「当前账号没有该 Server 权限」这类确定性失败纯属空转。
 *
 * 这里锁定三件事：
 *   1. provision 会把更收敛的策略（2s 起、4 次）写进条目 config；
 *   2. 终态鉴权失败时策略变为 enabled:false，宿主不再重连；
 *   3. 非法/缺省的重连入参一律不下发——宿主对未知键会直接拒绝加载条目。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEntryConfig } from '../lib/mcp-provision.js';
import { isTerminalAuthFailure } from '../lib/health-mode.js';

const http = { serverName: 'qcc-history', key: 'qcc-history-main', transport: 'streamable-http', url: 'https://example.invalid/mcp', auth: { mode: 'none' } };
const stdio = { serverName: 'local', key: 'local-main', transport: 'stdio', command: 'node', args: [] };

test('重连策略写进 streamable-http 与 stdio 两种条目', () => {
  const policy = { initialDelayMs: 2_000, maxAttempts: 4, maxDelayMs: 30_000 };
  for (const record of [http, stdio]) {
    const config = buildEntryConfig(record, new Map(), { reconnect: policy });
    assert.deepEqual(config.reconnect, { enabled: true, initialDelayMs: 2_000, maxDelayMs: 30_000, maxAttempts: 4 });
  }
});

test('终态鉴权失败：条目直接关掉宿主重连', () => {
  assert.equal(isTerminalAuthFailure({ errorKind: 'auth' }), true);
  const config = buildEntryConfig(http, new Map(), { reconnect: { initialDelayMs: 2_000, maxAttempts: 4, enabled: false } });
  assert.equal(config.reconnect.enabled, false, '未授权时宿主不该继续指数退避');
});

test('不传策略时不写 reconnect 键，沿用宿主默认', () => {
  for (const record of [http, stdio]) {
    assert.equal('reconnect' in buildEntryConfig(record, new Map()), false);
    assert.equal('reconnect' in buildEntryConfig(record, new Map(), { reconnect: null }), false);
  }
});

test('非法策略被丢弃：宿主只接受四个白名单键，多余键会让条目加载失败', () => {
  // 缺 initialDelayMs / maxAttempts 非法 / maxDelayMs 小于起步延迟 → 全部不下发
  assert.equal('reconnect' in buildEntryConfig(http, new Map(), { reconnect: { maxAttempts: 4 } }), false);
  assert.equal('reconnect' in buildEntryConfig(http, new Map(), { reconnect: { initialDelayMs: 2_000, maxAttempts: 0 } }), false);
  assert.equal('reconnect' in buildEntryConfig(http, new Map(), { reconnect: { initialDelayMs: 2_000, maxAttempts: 1.5 } }), false);
  assert.equal('reconnect' in buildEntryConfig(http, new Map(), { reconnect: { initialDelayMs: 2_000, maxAttempts: 4, maxDelayMs: 100 } }), false);
  // 合法输入只会产出白名单键，未知键被丢掉
  const config = buildEntryConfig(http, new Map(), { reconnect: { initialDelayMs: 2_000, maxAttempts: 4, bogus: 1 } });
  assert.deepEqual(Object.keys(config.reconnect).sort(), ['enabled', 'initialDelayMs', 'maxAttempts', 'maxDelayMs']);
});
