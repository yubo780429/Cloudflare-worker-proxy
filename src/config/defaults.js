/**
 * 默认配置（原 worker.js CONFIG_DEFAULTS，逐字搬移，未改行为）。
 *
 * 所有配置项均可被环境变量覆盖（推荐在 wrangler.toml 的 [vars]
 * 中设置），环境变量未设置时使用这里的默认值。
 */
export const CONFIG_DEFAULTS = {
  /**
   * 允许访问此 Worker 的对外域名。
   *
   * 请求的 HTTP Host 必须在此列表中，否则返回 421。
   */
  allowedHosts: ["example.com"],

  /**
   * 上游配置块列表（域名 + 端口 + 路由）。
   *
   * 每个元素是一个上游配置块：
   * {
   *   host:       上游主机名或 IP（必填）。不要带 https:// 和路径。
   *   port:       上游端口（数字或数字字符串）。
   *               空字符串 "" 表示使用协议默认端口（443 / 80）。
   *               支持 9090、20252 等非标准端口——Workers 的 fetch
   *               子请求不受 Cloudflare 回源端口白名单限制（该白名单
   *               只约束 CDN 代理通道，不约束 Workers）。
   *   protocol:   "https:" 或 "http:"（全局统一，默认 "https:"）。
   *   publicHost: 该配置块只服务哪个对外域名（可选，小写）。
   *               空字符串表示通配：任何对外域名都可路由到此上游。
   * }
   *
   * 端口映射关系（重要，必读）：
   *
   *   客户端永远只能通过标准端口（443）访问本 Worker——
   *   Cloudflare 边缘不监听 9090 / 20252 这样的非标端口，
   *   https://example.com:9090 在边缘层就会被拒绝，与 Worker 无关。
   *
   *   端口映射发生在 Worker → 上游这一段：
   *     https://app.example.com/api  →  http://10.0.0.2:9090/api
   *     https://nas.example.com/web  →  http://10.0.0.2:20252/web
   *
   * 路由规则：
   *   1. 优先在 publicHost 等于请求 Host 的配置块中选择；
   *   2. 没有匹配时，在 publicHost 为空的通配配置块中随机选择
   *      （保留原有多上游负载均衡语义）。
   */
  upstreams: [
    {
      host: "upstream.example.com",
      port: "",
      protocol: "https:",
      publicHost: "",
    },
  ],

  /** 是否将上游的绝对重定向地址改写回对外域名。 */
  rewriteLocation: true,

  /** 是否处理上游响应中的 Set-Cookie。处理方式由 cookieDomainMode 决定。 */
  rewriteCookies: true,

  /**
   * Set-Cookie 中 Domain 属性的处理模式：
   *
   * strip（默认）：移除 Domain 属性，使 Cookie 成为当前对外域名的
   *               Host-only Cookie，不会泄漏到其他子域，更安全。
   * rewrite：     将 Domain 改写为对外域名，适用于多个子域之间
   *               共享登录态（如 SSO）的场景。
   */
  cookieDomainMode: "strip",

  /**
   * 是否将请求中的 Origin 和 Referer 从对外域名改写为上游域名。
   *
   * 某些应用会检查 Origin 或 Referer。启用后可以减少上游返回
   * 403、CSRF 校验失败等情况。
   */
  rewriteRequestOrigin: true,

  /**
   * 是否添加反向代理诊断响应头。
   *
   * 默认关闭。诊断头会暴露上游域名，仅排查问题时临时开启。
   */
  addDiagnosticHeaders: false,

  /**
   * 等待上游返回响应头的最长时间（TTFB），单位为毫秒。
   *
   * 注意：本超时在拿到响应头后即解除，不约束响应体的流式传输。
   * 这是有意为之——SSE、WebSocket 等长连接不会被此超时中断
   * （已经 workerd 实测确认）。
   */
  upstreamTimeoutMs: 30000,

  /**
   * 是否允许健康检查接口。
   *
   * 健康检查地址：https://example.com/__proxy_health
   *
   * 默认响应不包含上游域名等敏感信息；仅当 addDiagnosticHeaders
   * 开启时才附带上游列表用于排查。
   */
  enableHealthCheck: true,
};
