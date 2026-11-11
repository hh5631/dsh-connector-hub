/**
 * 回归：Host serverName 前缀（`hub-`）与公开工具名的一致性。
 *
 * 历史缺陷：插件给 mcp-client 条目统一加 `hub-` 前缀，但健康检查、治理、
 * 工作区作用域与会话注入都直接拼 `mcp__${record.serverName}__` 去匹配
 * Host 里真实注册的工具名，前缀对不上导致「工具明明能调用，面板却报
 * 状态未知 / host-tools-pending」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HOST_SERVER_PREFIX, hostServerName, toHostServerName, publicToolPrefix,
  ownsPublicName, findRecordForPublicName, rawToolNameOf,
} from '../lib/server-name.js';
import { publicToolName } from '../lib/governance.js';
import { buildEntryConfig } from '../lib/mcp-provision.js';

const playwright = { serverName: 'playwright', key: 'playwright-playwright' };
const github = { serverName: 'github', key: 'github-github' };

test('Host serverName 统一加 hub- 前缀，且幂等', () => {
  assert.equal(HOST_SERVER_PREFIX, 'hub-');
  assert.equal(hostServerName(playwright), 'hub-playwright');
  assert.equal(toHostServerName('playwright'), 'hub-playwright');
  assert.equal(toHostServerName('hub-playwright'), 'hub-playwright', '已带前缀不得重复加');
  assert.equal(hostServerName({}), 'hub-', '缺 serverName 时也不抛错');
});

test('公开工具名前缀使用 Host serverName', () => {
  assert.equal(publicToolPrefix(playwright), 'mcp__hub-playwright__');
  assert.equal(publicToolName('playwright', 'browser_click'), 'mcp__hub-playwright__browser_click');
});

test('mcp-client 条目 serverName 与实际公开工具名一致', () => {
  const config = buildEntryConfig({ ...playwright, transport: 'stdio', command: 'npx', args: [] }, new Map());
  assert.equal(config.serverName, 'hub-playwright');
  // 这是最关键的断言：Host 注册的工具名必须能被本插件的匹配器认出来。
  const publicName = `${publicToolName(config.serverName, 'browser_click')}`;
  assert.equal(publicName, 'mcp__hub-playwright__browser_click');
  assert.ok(ownsPublicName(playwright, publicName), '真实 Host 工具名必须被认领');
});

test('反查连接记录：前缀精确匹配，不误吞包含关系', () => {
  const records = [playwright, github, { serverName: 'playwright-two' }];
  assert.equal(findRecordForPublicName(records, 'mcp__hub-playwright__browser_click')?.serverName, 'playwright');
  assert.equal(findRecordForPublicName(records, 'mcp__hub-github__create_issue')?.serverName, 'github');
  assert.equal(findRecordForPublicName(records, 'mcp__playwright__browser_click'), null, '不带前缀的旧名必须不匹配');
  assert.equal(findRecordForPublicName(records, 'mcp__hub-nope__x'), null);
  assert.equal(findRecordForPublicName(records, 'not-a-tool'), null);
  // 更长 serverName 优先
  assert.equal(findRecordForPublicName(records, 'mcp__hub-playwright-two__y')?.serverName, 'playwright-two');
});

test('rawToolNameOf 还原原始工具名', () => {
  assert.equal(rawToolNameOf(playwright, 'mcp__hub-playwright__browser_click'), 'browser_click');
  assert.equal(rawToolNameOf(playwright, 'mcp__hub-github__create_issue'), null);
  assert.equal(rawToolNameOf(playwright, 'mcp__hub-playwright__'), null, '空前缀后无工具名视为无效');
});

test('治理：公开工具名按 hub- 前缀生成，且能与记录反查对齐', async () => {
  const { resolveGovernancePolicy, matchesPublicName, legacyPublicToolName } = await import('../lib/governance.js');
  const publicName = publicToolName(playwright.serverName, 'browser_click');
  // 按 Host 里真实注册名字写的规则必须生效
  const rules = [{
    scope: 'tool', effect: 'deny', connectorId: 'playwright',
    serverName: 'playwright', toolName: 'browser_click', publicName,
  }];
  const policy = resolveGovernancePolicy({
    connectorId: 'playwright', serverName: 'playwright',
    toolName: 'browser_click', publicName, connectionEnabled: true,
  }, rules);
  assert.equal(policy.effect, 'deny');
  assert.equal(policy.source, 'tool');

  // 历史规则（旧的无前缀 publicName）也应继续生效，避免升级后规则静默失效
  const legacy = [{ ...rules[0], publicName: legacyPublicToolName('playwright', 'browser_click') }];
  assert.equal(legacy[0].publicName, 'mcp__playwright__browser_click');
  assert.ok(matchesPublicName(legacy[0], publicName), '旧规则必须能识别新公开名');
  assert.equal(resolveGovernancePolicy({
    connectorId: 'playwright', serverName: 'playwright',
    toolName: 'browser_click', publicName, connectionEnabled: true,
  }, legacy).effect, 'deny');

  // 无关工具不得被误判
  assert.equal(matchesPublicName(rules[0], 'mcp__hub-playwright__browser_close'), false);
});
