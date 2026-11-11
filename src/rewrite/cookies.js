/**
 * Set-Cookie 处理：逐条复制 / strip / rewrite Domain。
 *
 * 从原 worker.js 的 rewriteSetCookieHeaders / copySetCookieHeaders /
 * getSetCookieValues 逐字搬移，未改行为。
 *
 * 多条 Set-Cookie 必须保持为多个独立响应头，绝不能逗号合并
 * （Expires 属性本身含逗号，合并会破坏 Cookie）。
 */

/**
 * 复制并改写所有 Set-Cookie 响应头。
 *
 * 两种模式：
 *
 * strip（默认）：
 *   移除任意显式 Domain 属性。浏览器从 example.com 收到不带
 *   Domain 的 Cookie 后，会将它作为 example.com 的 Host-only
 *   Cookie，不会泄漏到其他子域。
 *
 * rewrite：
 *   将 Domain 属性改写为对外域名（如 Domain=example.com），
 *   适用于多个子域共享登录态的场景。
 *
 * @param {object} params
 */
export function rewriteSetCookieHeaders({
  targetHeaders,
  sourceHeaders,
  publicHost,
  cookieDomainMode,
}) {
  targetHeaders.delete("set-cookie");

  const cookies = getSetCookieValues(sourceHeaders);

  for (const originalCookie of cookies) {
    let rewrittenCookie;

    if (cookieDomainMode === "rewrite") {
      rewrittenCookie = originalCookie.replace(
        /;\s*Domain\s*=\s*[^;]+/gi,
        `; Domain=${publicHost}`,
      );
    } else {
      rewrittenCookie = originalCookie.replace(
        /;\s*Domain\s*=\s*[^;]+/gi,
        "",
      );
    }

    targetHeaders.append(
      "Set-Cookie",
      rewrittenCookie,
    );
  }
}

/**
 * 不改写 Cookie，仅复制全部 Set-Cookie 响应头。
 *
 * @param {Headers} targetHeaders
 * @param {Headers} sourceHeaders
 */
export function copySetCookieHeaders(
  targetHeaders,
  sourceHeaders,
) {
  targetHeaders.delete("set-cookie");

  const cookies = getSetCookieValues(sourceHeaders);

  for (const cookie of cookies) {
    targetHeaders.append("Set-Cookie", cookie);
  }
}

/**
 * 读取所有 Set-Cookie 响应头。
 *
 * Cloudflare Workers 提供 getAll("Set-Cookie")。
 * getSetCookie() 作为兼容性备用方式。
 *
 * @param {Headers} headers
 * @returns {string[]}
 */
export function getSetCookieValues(headers) {
  if (typeof headers.getAll === "function") {
    return headers.getAll("Set-Cookie");
  }

  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }

  /**
   * 最后的兼容性回退。
   *
   * 这里不按逗号拆分，因为 Cookie 的 Expires 属性本身可能包含逗号。
   */
  const value = headers.get("Set-Cookie");

  return value ? [value] : [];
}
