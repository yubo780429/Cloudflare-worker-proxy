/**
 * Worker 自身的健康检查响应。
 *
 * 从原 worker.js handleRequest 中的健康检查分支逐字搬移。
 * 默认响应只包含状态与时间戳；上游列表属于部署拓扑信息，
 * 仅在诊断模式开启时附带。
 */
export function createHealthResponse({ publicHost, config }) {
  const payload = {
    status: "ok",
    service: "cloudflare-worker-reverse-proxy",
    publicHost,
    timestamp: new Date().toISOString(),
  };

  if (config.addDiagnosticHeaders) {
    payload.upstreams = config.upstreams;
  }

  return Response.json(payload, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
