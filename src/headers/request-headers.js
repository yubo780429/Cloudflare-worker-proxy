/**
 * 发往上游的请求头策略。
 *
 * 从原 worker.js buildUpstreamRequest 的头部处理部分逐字搬移。
 * 只负责「删除伪造头 + 重建可信头」，不构造 Request，也不做
 * Origin / Referer 改写（后者属于 rewrite 层）。
 */
export function createForwardHeaders({ request, incomingUrl, publicHost }) {
  const headers = new Headers(request.headers);

  /**
   * 删除客户端传入的 Host。
   *
   * Worker 会根据 upstreamUrl.hostname 自动使用正确的上游主机名，
   * 避免上游收到 example.com 作为内部请求目标。
   */
  headers.delete("host");

  /**
   * 删除客户端可以伪造的转发头。
   *
   * 随后由 Worker 重新写入可信值。
   */
  headers.delete("forwarded");
  headers.delete("x-forwarded-host");
  headers.delete("x-forwarded-server");
  headers.delete("x-original-host");
  headers.delete("x-real-ip");

  /**
   * 告诉上游，客户端原本访问的公开域名和协议。
   *
   * 上游应用如果需要，可以主动读取这些请求头。
   */
  headers.set("x-forwarded-host", publicHost);
  headers.set(
    "x-forwarded-proto",
    incomingUrl.protocol.replace(":", ""),
  );

  /**
   * 如果请求中存在 Cloudflare 提供的访问者 IP，则将其写入
   * X-Forwarded-For。
   *
   * 不使用客户端自己传入的 X-Forwarded-For，避免伪造。
   */
  const connectingIp = request.headers.get("cf-connecting-ip");

  if (connectingIp) {
    headers.set("x-forwarded-for", connectingIp);
  } else {
    headers.delete("x-forwarded-for");
  }

  return headers;
}
