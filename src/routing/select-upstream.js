/**
 * 从上游配置块列表中选择本次请求的上游。
 *
 * 从原 worker.js 的 selectUpstream 逐字搬移，未改行为。
 *
 * 路由规则：
 *   1. 优先在 publicHost 等于请求对外域名的配置块中选择；
 *   2. 没有匹配时，在 publicHost 为空的通配配置块中随机选择。
 *
 * 只有一个上游时，总是返回同一个配置块。
 *
 * 注意：同一匹配池内的随机选择仅适用于"同一服务的多节点
 * 负载均衡"。不同端口背后若是不同服务（如 9090 是面板、
 * 20252 是存储），必须为它们配置不同的 publicHost，
 * 否则请求会被随机打到错误的服务上。
 *
 * 当前不支持池内故障转移：选中的上游不可用时该请求直接
 * 失败（502），不会自动重试其余节点。
 *
 * @param {object[]} upstreams 上游配置块列表
 * @param {string} publicHost 请求的对外域名（小写）
 * @returns {object} 选中的上游配置块
 */
export function selectUpstream(upstreams, publicHost) {
  if (
    !Array.isArray(upstreams) ||
    upstreams.length === 0
  ) {
    throw new Error("未配置任何上游域名");
  }

  const matched = upstreams.filter(
    (entry) => entry.publicHost && entry.publicHost === publicHost,
  );

  const pool =
    matched.length > 0
      ? matched
      : upstreams.filter((entry) => !entry.publicHost);

  if (pool.length === 0) {
    throw new Error(`没有可服务 ${publicHost} 的上游配置块`);
  }

  const index = Math.floor(
    Math.random() * pool.length,
  );

  return pool[index];
}
