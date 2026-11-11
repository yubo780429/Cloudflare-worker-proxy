/**
 * 请求生命周期编排（唯一流程协调者）。
 *
 * 从原 worker.js 的 handleRequest 逐字搬移，未改行为。
 *
 * 固定顺序（拆分时不得调整）：
 *   入口 Host 白名单 → 健康检查 → 选上游 → 构造转发请求
 *   → 上游 fetch（TTFB 超时） → 101 直通 → 构造客户端响应
 *
 * 底层模块只接收参数并返回结果，不反向导入本文件。
 */
import { createErrorResponse } from "../http/errors.js";
import { createHealthResponse } from "../http/health.js";
import { selectUpstream } from "../routing/select-upstream.js";
import { buildUpstreamRequest } from "../proxy/build-request.js";
import { fetchUpstream } from "../proxy/fetch-upstream.js";
import { buildClientResponse } from "../proxy/build-response.js";

/**
 * 处理客户端传入的请求。
 *
 * @param {Request} request
 * @param {object} config
 * @returns {Promise<Response>}
 */
export async function handleRequest(request, config) {
  const incomingUrl = new URL(request.url);
  const publicHost = incomingUrl.hostname.toLowerCase();

  /**
   * 限制入口域名。
   *
   * 这样可以避免别人通过其他绑定域名或 workers.dev 域名，
   * 将此 Worker 当作公共反向代理使用。
   *
   * 必须保持先于健康检查和代理转发，否则会绕过白名单。
   */
  if (!config.allowedHosts.includes(publicHost)) {
    return createErrorResponse(
      421,
      "Misdirected Request",
      "host-not-allowed",
    );
  }

  /**
   * Worker 自身的健康检查接口。
   *
   * 此请求不会被转发到上游。
   */
  if (
    config.enableHealthCheck &&
    incomingUrl.pathname === "/__proxy_health" &&
    request.method === "GET"
  ) {
    return createHealthResponse({ publicHost, config });
  }

  /**
   * OPTIONS 请求可能是浏览器发起的 CORS 预检请求。
   *
   * 这里仍然转发给上游，让上游应用自行决定允许哪些来源、
   * 方法和请求头，避免 Worker 无条件放宽安全限制。
   */

  /**
   * 按路由规则选择上游配置块（含 host / port / protocol）。
   *
   * 端口映射在此生效：客户端走标准端口 443 进入，
   * 这里把目标改写到配置块指定的上游端口（如 9090 / 20252）。
   */
  const upstream = selectUpstream(config.upstreams, publicHost);

  /**
   * 复制原始 URL。
   *
   * 原始路径和查询参数都会完整保留，只替换协议、主机名和端口。
   */
  const upstreamUrl = new URL(incomingUrl.toString());

  upstreamUrl.protocol = upstream.protocol;
  upstreamUrl.hostname = upstream.host;
  upstreamUrl.port = upstream.port;

  const upstreamRequest = buildUpstreamRequest({
    request,
    incomingUrl,
    upstreamUrl,
    publicHost,
    upstream,
    config,
  });

  const { response: upstreamResponse, timedOut } = await fetchUpstream({
    upstreamRequest,
    upstreamUrl,
    timeoutMs: config.upstreamTimeoutMs,
  });

  if (timedOut) {
    return createErrorResponse(
      504,
      "Gateway Timeout",
      "upstream-timeout",
    );
  }

  /**
   * WebSocket 升级成功时，上游会返回 101。
   *
   * 这类响应不能重新构造，否则可能丢失附着在 Response 上的
   * WebSocket 对象，因此直接返回原始响应。
   */
  if (upstreamResponse.status === 101) {
    return upstreamResponse;
  }

  return buildClientResponse({
    upstreamResponse,
    incomingUrl,
    publicHost,
    upstream,
    config,
  });
}
