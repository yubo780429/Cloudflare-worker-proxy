/**
 * 上游 fetch 与 TTFB（首字节）超时控制。
 *
 * 从原 worker.js handleRequest 中的 fetch 段逐字搬移。
 * 超时只约束「等待上游响应头」，拿到响应头即 clearTimeout，
 * 绝不延伸到响应体读取阶段，因此不会中断 SSE / 大文件 / 长连接。
 *
 * 为保持底层模块「只返回结果、不决定流程」的约定，超时以
 * { timedOut: true } 返回，由 handle-request.js 决定 504 响应；
 * 日志字段、状态码、错误码与原实现完全一致。
 */
import { redactUrl } from "../http/errors.js";

export async function fetchUpstream({ upstreamRequest, upstreamUrl, timeoutMs }) {
  /**
   * 创建超时控制器。
   *
   * 只约束"等待上游响应头"的时间；响应体开始返回后即解除，
   * 不会中断流式传输（SSE / 大文件下载 / WebSocket 均不受影响）。
   */
  const abortController = new AbortController();

  const timeoutId = setTimeout(() => {
    abortController.abort("上游请求超时");
  }, timeoutMs);

  try {
    /**
     * 使用 manual 模式禁止自动跟随重定向。
     *
     * 这样 Worker 才能取得上游的 Location 响应头，并将其中的
     * 上游域名改写回对外域名。
     */
    const upstreamResponse = await fetch(upstreamRequest, {
      redirect: "manual",
      signal: abortController.signal,
    });

    return { response: upstreamResponse, timedOut: false };
  } catch (error) {
    if (
      error?.name === "AbortError" ||
      abortController.signal.aborted
    ) {
      console.error(
        JSON.stringify({
          event: "upstream_timeout",
          upstreamUrl: redactUrl(upstreamUrl.toString()),
          timeoutMs,
        }),
      );

      return { response: null, timedOut: true };
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
