/**
 * 契约：新连接默认「按会话启用」，且会话层永不隐藏宿主的激活工具。
 *
 * 背景：dsh-mcp-client-toolLoading 补丁曾在宿主侧把 `toolLoading` 缺省改成
 * `deferred`，让 MCP 工具默认不进每轮 schema。补丁移除后这份责任由本插件承担：
 * 若缺省回退成 `always`，每个新连接的全部工具会重新常驻下发——正是补丁要解决的
 * 那个问题。同时补丁会注册 `mcp__<server>__dsh_use_tools`，它落在连接的公开名下，
 * 一旦被会话层 deny 掉，工具既不可见也无从激活，形成死锁。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_INJECTION_MODE,
  INJECTION_MODES,
  normalizeInjectionMode,
  setDefaultInjectionMode,
} from '../lib/session-injection.js';
import { publicToolPrefix, rawToolNameOf } from '../lib/server-name.js';
import { publicToolName } from '../lib/governance.js';

const record = { serverName: 'qcc-company', key: 'qcc-company-qcc-company' };

test('新连接缺省注入模式是 session（补丁移除后的兜底）', () => {
  assert.equal(DEFAULT_INJECTION_MODE, 'session');
  assert.equal(normalizeInjectionMode(undefined), 'session');
  assert.equal(normalizeInjectionMode(null), 'session');
  assert.equal(normalizeInjectionMode(''), 'session');
});

test('显式值优先于缺省，非法值报错而不是静默降级', () => {
  assert.equal(normalizeInjectionMode('always'), 'always');
  assert.equal(normalizeInjectionMode('session'), 'session');
  assert.throws(() => normalizeInjectionMode('sometimes'), /不支持的工具注入模式/);
  assert.deepEqual(INJECTION_MODES, ['always', 'session']);
});

test('setDefaultInjectionMode 只接受合法枚举，非法值保持现状', () => {
  const before = normalizeInjectionMode(undefined);
  setDefaultInjectionMode('always');
  assert.equal(normalizeInjectionMode(undefined), 'always');
  setDefaultInjectionMode('nope');
  assert.equal(normalizeInjectionMode(undefined), 'always', '非法值不得改动缺省');
  setDefaultInjectionMode('session');
  assert.equal(normalizeInjectionMode(undefined), before);
});

test('fallback 参数可覆盖运行期缺省（迁移/测试用）', () => {
  assert.equal(normalizeInjectionMode(undefined, { fallback: 'always' }), 'always');
  assert.equal(normalizeInjectionMode(undefined, { fallback: 'session' }), 'session');
});

test('宿主的 dsh_use_tools 激活工具可被正确识别（含冲突后缀）', () => {
  const rawOf = (name) => rawToolNameOf(record, name);
  // 补丁注册的激活工具名
  const activation = publicToolName('hub-qcc-company', 'dsh_use_tools');
  assert.equal(activation, 'mcp__hub-qcc-company__dsh_use_tools');
  assert.equal(rawOf(activation), 'dsh_use_tools');

  // 与真实工具撞名时的去重后缀：官方实现依次尝试 _2、_3…
  assert.equal(rawOf('mcp__hub-qcc-company__dsh_use_tools_2'), 'dsh_use_tools_2');
  assert.equal(rawOf('mcp__hub-qcc-company__dsh_use_tools_11'), 'dsh_use_tools_11');

  // 前缀契约必须与 server-name.js 的换算一致
  assert.equal(activation.startsWith(publicToolPrefix(record)), true);
});

test('普通业务工具不会被误判为激活工具', () => {
  for (const name of ['get_company_by_query', 'dsh_use_tool', 'dsh_use_tools_x']) {
    assert.equal(/^dsh_use_tools(_\d+)?$/.test(name), false, `${name} 不应算激活工具`);
  }
});
