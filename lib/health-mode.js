/**
 * 健康检查分层决策（纯函数，无副作用，便于单元测试）。
 *
 * 把 healthCheck 里最容易出逻辑岔子的「本次要不要跑业务探针 / 能不能复用
 * 轻量缓存」单独抽出来，避免在庞大的 api 方法里靠源码肉眼审查：
 *   - 轻量（默认）：命中近期 state.health 缓存就直接复用，既不握手也不跑探针；
 *   - 深度（deep=true）：正常握手，且仅当开关都允许时追加只读业务探针；
 *   - force=true 跳过缓存强制重跑；ttlMs 覆盖 config.lightHealthTtlMs（默认 60s）。
 */

/**
 * @param {object}  options  来自 API/工具的第 4 参：{deep, force, deepProbeEnabled, ttlMs}
 * @param {object}  config   插件配置：{deepHealthProbe, lightHealthTtlMs}
 * @param {object}  context  {workspaceId, connectionKey} —— 决定是否定向(scoped)
 */
export function resolveHealthCheckMode(options = {}, config = {}, context = {}) {
  const deep = options?.deep === true;
  const force = options?.force === true;
  const probeEnabled = options?.deepProbeEnabled !== false;
  const runProbe = deep && probeEnabled && config?.deepHealthProbe !== false;
  const ttlMs = Number.isFinite(options?.ttlMs)
    ? options.ttlMs
    : (Number.isFinite(config?.lightHealthTtlMs) ? config.lightHealthTtlMs : 60_000);
  const scoped = Boolean(context?.workspaceId || context?.connectionKey);
  // 只有「轻量 + 非强制 + 非定向 + 非单连接」才允许复用 TTL 缓存，
  // 保证用户显式点「深度检查」/「重新检查」/工具浏览器检查时真实执行。
  const cacheReusable = !deep && !force && !scoped && !context?.connectionKey;
  return { deep, force, probeEnabled, runProbe, ttlMs, scoped, cacheReusable };
}

/** 缓存是否仍在 TTL 内且可安全复用（checkedAt 由 buildHealthSummary 写入）。 */
export function shouldReuseHealthCache(mode, cached, now = Date.now()) {
  if (!mode?.cacheReusable || !cached) return false;
  const age = cached.checkedAt ? now - cached.checkedAt : Infinity;
  return age >= 0 && age < mode.ttlMs;
}

/**
 * 业务探针结果能否复用（避免「每点一次深度检查就把所有连接同时探活一遍」）。
 *
 * 只复用 **verified** 结论：credential-invalid / unknown 必须重探——
 * 前者要等修复后确认恢复，后者本来就不可信。force 时一律重探。
 */
export function shouldReuseBusinessReadiness(mode, cached, now = Date.now()) {
  if (!mode?.runProbe || mode?.force || !cached) return false;
  if (cached.readiness !== 'verified') return false;
  const age = cached.checkedAt ? now - cached.checkedAt : Infinity;
  return age >= 0 && age < mode.ttlMs;
}

/** 深度探针并发上限：别让 N 条连接 × 8s 超时同时压满事件循环与远端。 */
export function resolveProbeConcurrency(config = {}, targetCount = 0) {
  const raw = Number(config?.deepProbeConcurrency);
  const limit = Number.isFinite(raw) && raw >= 1 ? Math.trunc(raw) : 3;
  const count = Number.isFinite(targetCount) ? Math.max(0, Math.trunc(targetCount)) : 0;
  return Math.max(1, Math.min(limit, count || limit));
}

/**
 * 有界并发地跑异步任务，结果按入参顺序返回（与 Promise.all 同序）。
 * 在 healthCheck 里用它替代 `targets.map(...)` + `Promise.all`：
 * 连接多时也不会一次性把所有业务探针同时打出去。
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
export async function runWithConcurrency(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  const width = Math.max(1, Math.min(Number.isFinite(limit) ? Math.trunc(limit) : 1, list.length || 1));
  let cursor = 0;
  await Promise.all(Array.from({ length: width }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
      results[index] = await worker(list[index], index);
    }
  }));
  return results;
}

/**
 * 终态失败（401/403、未授权、token 失效）要不要重新排队。
 *
 * 宿主 mcp-client 默认从 500ms 起、10 次上限指数退避重连，对「当前账号没有该
 * Server 权限」这类确定性失败只会刷日志并空转；发现流程（discovery-policy.js
 * 的 nextDiscovery）对 errorKind==='auth' 一律返回 nextAt:null，即不再排队。
 * 这里把同一判定抽成纯函数，供 toolsList 与测试共同引用，避免两处各写一套。
 */
export function isTerminalAuthFailure(outcome) {
  return Boolean(outcome) && outcome.errorKind === 'auth';
}
