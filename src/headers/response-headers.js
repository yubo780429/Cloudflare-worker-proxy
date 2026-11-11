/**
 * 返回给客户端的响应头策略。
 *
 * 从原 worker.js 的 HOP_BY_HOP_RESPONSE_HEADERS、
 * copyResponseHeaders 及 buildClientResponse 的头部清理/诊断部分
 * 逐字搬移。函数按原调用顺序由 build-response.js 组装。
 */

/**
 * 逐跳（hop-by-hop）响应头黑名单。
 *
 * 这些响应头只属于单条 TCP 连接，不属于端到端内容，
 * 不应转发给客户端。
 */
export const HOP_BY_HOP_RESPONSE_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

/**
 * 复制普通响应头，但跳过 Set-Cookie。
 *
 * 多个 Set-Cookie 必须保持为多个独立响应头，不能使用逗号合并。
 *
 * @param {Headers} sourceHeaders
 * @returns {Headers}
 */
export function copyResponseHeaders(sourceHeaders) {
  const targetHeaders = new Headers();

  for (const [name, value] of sourceHeaders.entries()) {
    if (name.toLowerCase() !== "set-cookie") {
      targetHeaders.append(name, value);
    }
  }

  return targetHeaders;
}

/** 清理不应透传给客户端的上游响应头。 */
export function sanitizeResponseHeaders(headers) {
  /**
   * 删除部分上游平台诊断信息。
   *
   * 这些响应头不是反向代理正常运行所必需的。
   */
  headers.delete("x-vercel-id");
  headers.delete("x-vercel-cache");

  /**
   * 删除上游返回的 Alt-Svc 响应头。（重要）
   *
   * Alt-Svc 中的主机名属于上游。如果原样透传，浏览器会按该头
   * 尝试直连上游建立 HTTP/3 连接，造成上游域名泄露，极端情况
   * 下（上游不校验 Host）会静默绕过本代理。
   */
  headers.delete("alt-svc");

  /**
   * 删除逐跳（hop-by-hop）响应头。
   *
   * 这些头只属于单条连接，不属于端到端内容。虽然 Workers 运行时
   * 通常会自行剥离它们，但不应依赖该隐式行为。
   *
   * 注意：WebSocket 的 101 响应不会走到这里（提前直通返回），
   * 因此这里的删除不影响 Upgrade 头的握手语义。
   */
  for (const name of HOP_BY_HOP_RESPONSE_HEADERS) {
    headers.delete(name);
  }

  /**
   * 删除可能已经失效的 Content-Length。
   *
   * Worker 返回流式响应时会自行处理响应长度。如果以后增加正文
   * 替换功能，保留旧 Content-Length 可能造成响应截断。
   *
   * 注意：206 响应的 Content-Range 会保留，断点续传不受影响。
   */
  headers.delete("content-length");
}

/** 诊断头开关与错误响应缓存策略。 */
export function applyResponseHeaderPolicy({ headers, upstream, config, status }) {
  /**
   * 可选的诊断响应头。
   *
   * 默认关闭。开启后会暴露上游域名，仅排查问题时使用。
   */
  if (config.addDiagnosticHeaders) {
    headers.set(
      "X-Reverse-Proxy",
      "cloudflare-worker",
    );

    headers.set(
      "X-Reverse-Proxy-Upstream",
      upstream.host + (upstream.port ? `:${upstream.port}` : ""),
    );
  }

  /**
   * 错误响应和动态请求不进行浏览器缓存。
   *
   * 正常静态资源是否缓存，继续遵循上游返回的 Cache-Control。
   */
  if (status >= 400) {
    headers.set("Cache-Control", "no-store");
  }
}
