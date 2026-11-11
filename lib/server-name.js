/**
 * Host 上的 serverName 与逻辑 serverName 的唯一换算点。
 *
 * 本插件给 `@deepseek-ai/dsh-mcp-client` 条目的 serverName 加 `hub-` 前缀
 * （隔离原因见 mcp-provision.js），于是 Host 里真实的公开工具名是
 * `mcp__hub-<serverName>__<tool>`，而连接记录、目录、治理规则里保存的仍是
 * 不带前缀的逻辑 serverName。
 *
 * 任何「按公开工具名反查连接」或「由记录拼公开工具名」的地方都必须经过
 * 这里。历史上这些地方直接拼 `mcp__${record.serverName}__`，前缀对不上导致
 * 匹配全部落空：读取已注册工具恒为空 → 健康检查把「可正常调用」误报成
 * 「状态未知 / host-tools-pending」，治理规则与工作区作用域也静默失效。
 */

export const HOST_SERVER_PREFIX = 'hub-';

/** 逻辑 serverName 字符串 → Host 条目 serverName（幂等，已带前缀不重复加）。 */
export function toHostServerName(rawName) {
  const raw = String(rawName ?? '');
  return raw.startsWith(HOST_SERVER_PREFIX) ? raw : `${HOST_SERVER_PREFIX}${raw}`;
}

/** 记录的逻辑 serverName → Host 条目 serverName。 */
export function hostServerName(record) {
  return toHostServerName(record?.serverName);
}

/** 公开工具名前缀，形如 `mcp__hub-<serverName>__`。 */
export function publicToolPrefix(record) {
  return `mcp__${hostServerName(record)}__`;
}

/** 该公开工具名是否属于这条连接记录。 */
export function ownsPublicName(record, name) {
  return typeof name === 'string' && name.startsWith(publicToolPrefix(record));
}

/**
 * 从 Host 公开工具名反查所属连接记录。
 * 前缀更长的优先，避免 `hub-a` 误吞 `hub-a-b` 这类包含关系。
 */
export function findRecordForPublicName(records, name) {
  if (typeof name !== 'string' || !name.startsWith('mcp__')) return null;
  return [...(records ?? [])]
    .filter((record) => ownsPublicName(record, name))
    .sort((a, b) => hostServerName(b).length - hostServerName(a).length)[0] ?? null;
}

/** 从公开工具名里取出原始工具名；不属于该记录时返回 null。 */
export function rawToolNameOf(record, name) {
  if (!ownsPublicName(record, name)) return null;
  return name.slice(publicToolPrefix(record).length) || null;
}
