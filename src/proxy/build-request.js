/**
 * 构造由 Worker 发往上游的请求。
 *
 * 从原 worker.js 的 buildUpstreamRequest 逐字搬移；头部策略与
 * Origin / Referer 改写分别下沉到 headers / rewrite 层。
 *
 * 响应体保持 request.body 原样传递，不读取、不缓存、不重建。
 *
 * @param {object} params
 * @returns {Request}
 */
import { createForwardHeaders } from "../headers/request-headers.js";
import { applyOriginRefererRewrite } from "../rewrite/origin-referer.js";

export function buildUpstreamRequest({
  request,
  incomingUrl,
  upstreamUrl,
  publicHost,
  upstream,
  config,
}) {
  const headers = createForwardHeaders({ request, incomingUrl, publicHost });

  applyOriginRefererRewrite({
    headers,
    publicHost,
    upstream,
    enabled: config.rewriteRequestOrigin,
  });

  /**
   * 根据新的上游 URL 和原始 Request 构造转发请求。
   *
   * 注意（实测修复）：Request 构造器只接受 (input, init) 两个参数。
   * 此前写成 new Request(url, request, { headers }) ——第三个参数
   * 会被静默忽略，导致上面的头删除/重建/改写全部不生效，
   * 伪造的 X-Forwarded-* 原样到达上游。因此改为显式 init：
   *
   * - method / body 从原请求继承（GET/HEAD 的 body 为 null，无冲突）
   * - headers 使用删除伪造头、重建可信头之后的版本
   * - redirect: manual 禁止自动跟随重定向
   */
  return new Request(upstreamUrl.toString(), {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
  });
}
