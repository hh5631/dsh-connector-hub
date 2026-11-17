/**
 * 健康检查分层决策回归测试。
 *
 * 覆盖本轮「不用每次都深度检查」优化的核心：
 *   1. 默认轻量 → 绝不跑业务探针，且允许复用近期缓存；
 *   2. 仅 deep=true 且各开关都允许时才跑探针；
 *   3. force / 定向(scoped) / 单连接 必须跳过缓存，保证显式检查真实执行；
 *   4. TTL：过期缓存不复用，ttlMs 可覆盖 config 默认值。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveHealthCheckMode,
  shouldReuseHealthCache,
  shouldReuseBusinessReadiness,
  resolveProbeConcurrency,
  runWithConcurrency,
  isTerminalAuthFailure,
} from '../lib/health-mode.js';

const CONFIG = { deepHealthProbe: true, lightHealthTtlMs: 60_000 };

test('轻量默认：不跑业务探针，且允许复用缓存', () => {
  const m = resolveHealthCheckMode({}, CONFIG, {});
  assert.equal(m.deep, false);
  assert.equal(m.runProbe, false, '轻量模式绝不跑业务探针');
  assert.equal(m.cacheReusable, true, '轻量默认允许复用近期缓存');
  assert.equal(m.ttlMs, 60_000);
  assert.equal(m.scoped, false);
});

test('深度检查：跑探针，且不允许复用缓存', () => {
  const m = resolveHealthCheckMode({ deep: true }, CONFIG, {});
  assert.equal(m.runProbe, true);
  assert.equal(m.cacheReusable, false, '用户显式深度检查必须真实执行');
});

test('深度检查 + deepProbeEnabled:false：只握手不跑探针（UI 开关真生效）', () => {
  const m = resolveHealthCheckMode({ deep: true, deepProbeEnabled: false }, CONFIG, {});
  assert.equal(m.deep, true);
  assert.equal(m.runProbe, false, '开关关掉后深度检查也不跑探针');
});

test('config.deepHealthProbe:false 全局关闭探针', () => {
  const m = resolveHealthCheckMode({ deep: true }, { ...CONFIG, deepHealthProbe: false }, {});
  assert.equal(m.runProbe, false);
});

test('force:true 跳过缓存强制重跑', () => {
  const m = resolveHealthCheckMode({ force: true }, CONFIG, {});
  assert.equal(m.cacheReusable, false);
  assert.equal(m.runProbe, false, '轻量强制刷新仍不跑探针');
});

test('定向（workspaceId / connectionKey）跳过缓存，仍走真实握手', () => {
  assert.equal(resolveHealthCheckMode({}, CONFIG, { workspaceId: 'ws1' }).scoped, true);
  assert.equal(resolveHealthCheckMode({}, CONFIG, { workspaceId: 'ws1' }).cacheReusable, false);
  assert.equal(resolveHealthCheckMode({}, CONFIG, { connectionKey: 'k1' }).scoped, true);
  assert.equal(resolveHealthCheckMode({}, CONFIG, { connectionKey: 'k1' }).cacheReusable, false);
});

test('仅传 connectorId 不算 scoped（UI 行内重新检查要能写回缓存）', () => {
  // 注意：定向判定只看 workspaceId / connectionKey，connectorId 是方法第 1 参、不进 context。
  const m = resolveHealthCheckMode({ deep: true, force: true }, CONFIG, {});
  assert.equal(m.scoped, false, '不传 workspaceId/connectionKey 才能命中 cacheHealth');
  assert.equal(m.cacheReusable, false, 'deep+force 仍不复用缓存');
});

test('ttlMs 覆盖 config，非法值回退默认', () => {
  assert.equal(resolveHealthCheckMode({ ttlMs: 0 }, CONFIG, {}).ttlMs, 0);
  assert.equal(resolveHealthCheckMode({ ttlMs: 1234 }, CONFIG, {}).ttlMs, 1234);
  assert.equal(resolveHealthCheckMode({ ttlMs: 'x' }, { deepHealthProbe: true }, {}).ttlMs, 60_000);
  assert.equal(resolveHealthCheckMode({}, {}, {}).ttlMs, 60_000);
});

test('缓存复用：TTL 内命中，过期/缺失/负年龄不复用', () => {
  const now = 1_000_000;
  const light = resolveHealthCheckMode({}, { deepHealthProbe: true, lightHealthTtlMs: 60_000 }, {});
  assert.equal(shouldReuseHealthCache(light, { checkedAt: now - 1000 }, now), true);
  assert.equal(shouldReuseHealthCache(light, { checkedAt: now - 60_000 }, now), false, '边界：恰好 TTL 不复用');
  assert.equal(shouldReuseHealthCache(light, { checkedAt: now - 120_000 }, now), false);
  assert.equal(shouldReuseHealthCache(light, { checkedAt: now + 5000 }, now), false, '负年龄不复用');
  assert.equal(shouldReuseHealthCache(light, {}, now), false, '无 checkedAt 不复用');
  assert.equal(shouldReuseHealthCache(light, null, now), false);
  assert.equal(shouldReuseHealthCache(resolveHealthCheckMode({ deep: true }, CONFIG, {}), { checkedAt: now - 1 }, now), false, '深度模式不复用');
});

/* ── 本轮新增：业务探针复用 / 有界并发 / 终态鉴权 ───────────── */

test('业务探针复用：只复用 TTL 内的 verified，force 一律重探', () => {
  const now = 2_000_000;
  const deep = resolveHealthCheckMode({ deep: true }, { deepHealthProbe: true, lightHealthTtlMs: 60_000 }, {});
  assert.equal(shouldReuseBusinessReadiness(deep, { readiness: 'verified', checkedAt: now - 1000 }, now), true);
  assert.equal(shouldReuseBusinessReadiness(deep, { readiness: 'verified', checkedAt: now - 60_000 }, now), false, '边界：恰好 TTL 不复用');
  assert.equal(shouldReuseBusinessReadiness(deep, { readiness: 'credential-invalid', checkedAt: now }, now), false, '失效结论必须重探');
  assert.equal(shouldReuseBusinessReadiness(deep, { readiness: 'unknown', checkedAt: now }, now), false, '未知结论必须重探');
  assert.equal(shouldReuseBusinessReadiness(deep, null, now), false);
  const forced = resolveHealthCheckMode({ deep: true, force: true }, CONFIG, {});
  assert.equal(shouldReuseBusinessReadiness(forced, { readiness: 'verified', checkedAt: now }, now), false, 'force 不复用');
  const light = resolveHealthCheckMode({}, CONFIG, {});
  assert.equal(shouldReuseBusinessReadiness(light, { readiness: 'verified', checkedAt: now }, now), false, '轻量不跑探针也就谈不上复用');
});

test('探针并发：默认 3，可配置，且不超过目标数量', () => {
  assert.equal(resolveProbeConcurrency({}, 10), 3, '默认 3：面板一打开不会把 N 条连接同时探活');
  assert.equal(resolveProbeConcurrency({ deepProbeConcurrency: 6 }, 10), 6);
  assert.equal(resolveProbeConcurrency({}, 2), 2, '目标只有 2 条时并发不超过 2');
  assert.equal(resolveProbeConcurrency({}, 0), 3, '无目标时仍返回合法上限');
  assert.equal(resolveProbeConcurrency({ deepProbeConcurrency: 0 }, 5), 3, '非法配置回退默认');
});

test('runWithConcurrency：结果按入参顺序、并发不越界、异常向上抛', async () => {
  let live = 0;
  let peak = 0;
  const out = await runWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((resolve) => setTimeout(resolve, 5));
    live -= 1;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10], '顺序与入参一致（不能靠完成先后）');
  assert.ok(peak <= 2, `并发峰值 ${peak} 不得超过上限 2`);
  await assert.rejects(runWithConcurrency([1], 1, async () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(await runWithConcurrency([], 3, async () => 1), []);
});

test('终态鉴权失败：只有 errorKind==="auth" 才算，其它仍交给退避重试', () => {
  assert.equal(isTerminalAuthFailure({ errorKind: 'auth' }), true);
  for (const kind of ['network', 'timeout', 'rate-limit', 'startup', 'http', undefined]) {
    assert.equal(isTerminalAuthFailure({ errorKind: kind }), false, `${kind ?? 'undefined'} 不是终态`);
  }
  assert.equal(isTerminalAuthFailure(null), false);
});
