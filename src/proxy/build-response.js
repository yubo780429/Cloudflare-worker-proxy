/**
 * 构造返回给客户端的响应。
 *
 * 从原 worker.js 的 buildClientResponse 逐字搬移，调用顺序保持原样：
 *   复制普通头 → Location 改写 → Set-Cookie 处理 → 头部清理 → 诊断/缓存策略
 *
 * 响应体始终是 upstreamResponse.body 原对象，不重建、不缓冲。
 *
 * @param {object} params
 * @returns {Response}
 */
import {
  copyResponseHeaders,
  sanitizeResponseHeaders,
  applyResponseHeaderPolicy,
} from "../headers/response-headers.js";
import { rewriteLocationHeader } from "../rewrite/location.js";
import {
  rewriteSetCookieHeaders,
  copySetCookieHeaders,
} from "../rewrite/cookies.js";

export function buildClientResponse({
  upstreamResponse,
  incomingUrl,
  publicHost,
  upstream,
  config,
}) {
  /**
   * 复制上游响应头。
   *
   * Set-Cookie 需要单独处理，不能与其他响应头使用相同逻辑复制。
   */
  const headers = copyResponseHeaders(
    upstreamResponse.headers,
  );

  /**
   * 将上游重定向地址中的上游域名改写为公开域名。
   */
  if (config.rewriteLocation) {
    rewriteLocationHeader({
      headers,
      incomingUrl,
      publicHost,
      upstream,
      config,
    });
  }

  /**
   * 复制并处理所有 Set-Cookie 响应头。
   */
  if (config.rewriteCookies) {
    rewriteSetCookieHeaders({
      targetHeaders: headers,
      sourceHeaders: upstreamResponse.headers,
      publicHost,
      cookieDomainMode: config.cookieDomainMode,
    });
  } else {
    copySetCookieHeaders(
      headers,
      upstreamResponse.headers,
    );
  }

  sanitizeResponseHeaders(headers);

  applyResponseHeaderPolicy({
    headers,
    upstream,
    config,
    status: upstreamResponse.status,
  });

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}
