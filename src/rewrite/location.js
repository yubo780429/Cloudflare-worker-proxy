/**
 * 改写上游返回的 Location 响应头。
 *
 * 从原 worker.js 的 rewriteLocationHeader 逐字搬移，未改行为。
 *
 * 例如：
 * https://upstream.example.com/login
 * 改写为：
 * https://example.com/login
 *
 * 指向其他第三方域名的跳转不会被修改。
 *
 * 注意：当前实现只比较 hostname，不比较端口；相对跳转以
 * `${upstream.protocol}//${upstream.host}`（不含端口）为基准。
 * 这些是既有行为，本次拆分不做修正（改进计划 P0-3 单列）。
 *
 * @param {object} params
 */
export function rewriteLocationHeader({
  headers,
  incomingUrl,
  publicHost,
  upstream,
  config,
}) {
  const location = headers.get("location");

  if (!location) {
    return;
  }

  try {
    /**
     * 第二个参数用于处理相对跳转地址。
     *
     * 例如上游返回：
     * Location: /login
     */
    const redirectUrl = new URL(
      location,
      `${upstream.protocol}//${upstream.host}`,
    );

    const redirectHost =
      redirectUrl.hostname.toLowerCase();

    /**
     * 只有跳转目标属于已配置的上游域名时才进行改写。
     *
     * OAuth、支付平台等外部跳转保持原样。
     */
    if (config.upstreamHosts.includes(redirectHost)) {
      redirectUrl.protocol = incomingUrl.protocol;
      redirectUrl.hostname = publicHost;
      redirectUrl.port = incomingUrl.port;

      headers.set(
        "location",
        redirectUrl.toString(),
      );
    }
  } catch (error) {
    /**
     * 如果 Location 不是有效 URL，则保留上游原始值。
     */
    console.warn(
      JSON.stringify({
        event: "location_header_parse_failed",
        location,
        error: String(error),
      }),
    );
  }
}
