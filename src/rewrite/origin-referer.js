/**
 * 请求侧 Origin / Referer 改写。
 *
 * 从原 worker.js 的 rewriteRequestHeaderUrl 逐字搬移，另加一个
 * 薄封装函数把「是否启用 + 两个头」的编排收在本层，
 * 使 build-request.js 不必知道改写细节。
 */

/**
 * 改写请求中的 Origin 或 Referer。
 *
 * 只有请求头中的主机名等于公开代理域名时才进行改写。
 * 第三方来源保持不变。
 *
 * @param {Headers} headers
 * @param {string} headerName
 * @param {string} publicHost
 * @param {object} upstream 选中的上游配置块（host / port / protocol）
 */
export function rewriteRequestHeaderUrl(
  headers,
  headerName,
  publicHost,
  upstream,
) {
  const value = headers.get(headerName);

  if (!value || value === "null") {
    return;
  }

  try {
    const headerUrl = new URL(value);

    if (
      headerUrl.hostname.toLowerCase() === publicHost
    ) {
      headerUrl.protocol = upstream.protocol;
      headerUrl.hostname = upstream.host;
      headerUrl.port = upstream.port;

      headers.set(
        headerName,
        headerUrl.toString(),
      );
    }
  } catch {
    /**
     * 如果请求头不是有效 URL，则保留原始值。
     */
  }
}

/** 按开关对 Origin / Referer 两个头执行改写。 */
export function applyOriginRefererRewrite({ headers, publicHost, upstream, enabled }) {
  if (!enabled) {
    return;
  }

  rewriteRequestHeaderUrl(headers, "origin", publicHost, upstream);
  rewriteRequestHeaderUrl(headers, "referer", publicHost, upstream);
}
