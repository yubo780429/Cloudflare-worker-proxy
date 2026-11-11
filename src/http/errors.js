/**
 * 统一错误出口：错误响应构造 + 错误日志 URL 脱敏。
 *
 * 从原 worker.js 的 createErrorResponse / redactUrl 逐字搬移。
 * 两者同属「错误出口」职责，放在同一模块避免为一个 8 行工具函数
 * 单独建 utils 层（遵循不过度拆分的原则）。
 */

/**
 * URL 脱敏：仅保留 origin + 路径，剔除查询串和哈希。
 *
 * 用于日志输出——查询串可能携带 token、会话 ID 等凭证，
 * 不应明文写入 Workers Logs / Logpush。
 *
 * @param {string} url
 * @returns {string}
 */
export function redactUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "<unparseable-url>";
  }
}

/**
 * 创建统一格式的错误响应。
 *
 * @param {number} status HTTP 状态码
 * @param {string} message 对外显示的信息
 * @param {string} errorCode 内部错误代码
 * @returns {Response}
 */
export function createErrorResponse(
  status,
  message,
  errorCode,
) {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Proxy-Error": errorCode,
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
