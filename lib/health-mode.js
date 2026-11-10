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
