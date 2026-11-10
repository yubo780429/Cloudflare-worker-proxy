/**
 * Cloudflare Worker 反向代理（优化版）
 *
 * 对外访问域名：
 *   example.com
 *
 * 上游应用域名：
 *   upstream.example.com
 *
 * 主要功能：
 * 1. 保留原请求的方法、路径、查询参数和请求体
 * 2. 将请求转发到指定的上游应用
 * 3. 将上游重定向地址改写回对外访问域名
 * 4. 处理上游 Set-Cookie 中的 Domain 属性（可选拆除 / 改写两种模式）
 * 5. 根据需要改写 Origin 和 Referer
 * 6. 支持 WebSocket 升级请求
 * 7. 限制允许访问的入口域名，避免成为开放代理
 * 8. 提供健康检查接口
 * 9. 提供上游首字节（TTFB）超时控制
 *
 * 相对初版的优化（均有实测依据，见 verify-report）：
 * A. 删除上游返回的 Alt-Svc 响应头——否则浏览器会按该头尝试直连上游
 *    建立 HTTP/3 连接，可能静默绕过本代理（必修项）。
 * B. 删除 hop-by-hop 响应头（connection / transfer-encoding 等），
 *    不再依赖运行时的隐式剥离行为。
 * C. 配置支持通过环境变量覆盖：同一份代码可部署 dev/staging/prod，
 *    本地测试也无需修改代码。
 * D. Set-Cookie 的 Domain 处理支持两种模式：
 *    strip（默认，成为对外域名的 Host-only Cookie，更安全）
 *    rewrite（改写为对外域名，供多子域共享登录态的场景使用）。
 * E. 健康检查默认不再返回上游域名列表；诊断响应头默认关闭，
 *    避免"隐藏上游"的部署目标被自身配置泄露。
 * F. 超时语义修正为"等待上游响应头的最长时间（TTFB）"，
 *    不约束响应体流式传输，因此不会中断 SSE / WebSocket 长连接。
 */

/**
 * 默认配置。
 *
 * 所有配置项均可被环境变量覆盖（推荐在 wrangler.toml 的 [vars]
 * 中设置），环境变量未设置时使用这里的默认值。
 */
const CONFIG_DEFAULTS = {
  /**
   * 允许访问此 Worker 的对外域名。
   *
   * 请求的 HTTP Host 必须在此列表中，否则返回 421。
   */
  allowedHosts: ["example.com"],

  /**
   * 上游应用域名列表。
   *
   * 不要填写 https://，也不要包含路径。
   */
  upstreamHosts: ["upstream.example.com"],

  /**
   * 访问上游使用的协议。
   */
  upstreamProtocol: "https:",

  /**
   * 访问上游使用的端口，空字符串表示协议默认端口。
   */
  upstreamPort: "",

  /**
   * 是否将上游的绝对重定向地址改写回对外域名。
   *
   * 例如：
   * https://upstream.example.com/login
   * 改写为：
   * https://example.com/login
   */
  rewriteLocation: true,

  /**
   * 是否处理上游响应中的 Set-Cookie。
   *
   * 处理方式由 cookieDomainMode 决定。
   */
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
   * 健康检查地址：
   * https://example.com/__proxy_health
   *
   * 默认响应不包含上游域名等敏感信息；仅当 addDiagnosticHeaders
   * 开启时才附带上游列表用于排查。
   */
  enableHealthCheck: true,
};

/**
 * 逐跳（hop-by-hop）响应头黑名单。
 *
 * 这些响应头只属于单条 TCP 连接，不属于端到端内容，
 * 不应转发给客户端。
 */
const HOP_BY_HOP_RESPONSE_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

export default {
  /**
   * Cloudflare Worker 的请求入口。
   *
   * @param {Request} request 客户端传入的请求
   * @param {object} env Worker 环境变量和绑定
   * @param {ExecutionContext} ctx Worker 执行上下文
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    const config = loadConfig(env);

    try {
      return await handleRequest(request, config);
    } catch (error) {
      /**
       * 结构化日志，便于在 Workers Logs / Logpush 中检索。
       */
      console.error(
        JSON.stringify({
          event: "proxy_unhandled_error",
          method: request.method,
          url: request.url,
          error: String(error && error.stack ? error.stack : error),
        }),
      );

      return createErrorResponse(
        502,
        "Bad Gateway",
        "upstream-request-failed",
      );
    }
  },
};

/**
 * 从环境变量加载配置，未设置的环境变量回落到默认值。
 *
 * @param {object} env Worker 环境变量
 * @returns {object}
 */
function loadConfig(env) {
  const e = env || {};

  /**
   * 解析布尔值。接受 "true" / "false"（不区分大小写）。
   */
  const parseBool = (value, fallback) => {
    if (value === undefined || value === null || value === "") {
      return fallback;
    }
    return String(value).toLowerCase() === "true";
  };

  /**
   * 解析逗号分隔的域名列表，统一转小写。
   */
  const parseList = (value, fallback) => {
    if (value === undefined || value === null || value === "") {
      return fallback;
    }
    return String(value)
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
  };

  /**
   * 解析正整数，非法值回落到默认值。
   */
  const parsePositiveInt = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : fallback;
  };

  /**
   * 规范化协议写法，保证带冒号（URL.protocol 需要）。
   */
  const normalizeProtocol = (value, fallback) => {
    const proto =
      value === undefined || value === null || value === ""
        ? fallback
        : String(value).toLowerCase();

    return proto.endsWith(":") ? proto : `${proto}:`;
  };

  const cookieDomainMode =
    String(e.PROXY_COOKIE_DOMAIN_MODE || "").toLowerCase() === "rewrite"
      ? "rewrite"
      : "strip";

  return {
    allowedHosts: parseList(e.PROXY_ALLOWED_HOSTS, CONFIG_DEFAULTS.allowedHosts),
    upstreamHosts: parseList(e.PROXY_UPSTREAM_HOSTS, CONFIG_DEFAULTS.upstreamHosts),
    upstreamProtocol: normalizeProtocol(e.PROXY_UPSTREAM_PROTOCOL, CONFIG_DEFAULTS.upstreamProtocol),
    upstreamPort: e.PROXY_UPSTREAM_PORT === undefined || e.PROXY_UPSTREAM_PORT === null
      ? CONFIG_DEFAULTS.upstreamPort
      : String(e.PROXY_UPSTREAM_PORT),
    rewriteLocation: parseBool(e.PROXY_REWRITE_LOCATION, CONFIG_DEFAULTS.rewriteLocation),
    rewriteCookies: parseBool(e.PROXY_REWRITE_COOKIES, CONFIG_DEFAULTS.rewriteCookies),
    cookieDomainMode,
    rewriteRequestOrigin: parseBool(e.PROXY_REWRITE_ORIGIN, CONFIG_DEFAULTS.rewriteRequestOrigin),
    addDiagnosticHeaders: parseBool(e.PROXY_DIAGNOSTIC_HEADERS, CONFIG_DEFAULTS.addDiagnosticHeaders),
    upstreamTimeoutMs: parsePositiveInt(e.PROXY_TIMEOUT_MS, CONFIG_DEFAULTS.upstreamTimeoutMs),
    enableHealthCheck: parseBool(e.PROXY_HEALTH_CHECK, CONFIG_DEFAULTS.enableHealthCheck),
  };
}

/**
 * 处理客户端传入的请求。
 *
 * @param {Request} request
 * @param {object} config
 * @returns {Promise<Response>}
 */
async function handleRequest(request, config) {
  const incomingUrl = new URL(request.url);
  const publicHost = incomingUrl.hostname.toLowerCase();

  /**
   * 限制入口域名。
   *
   * 这样可以避免别人通过其他绑定域名或 workers.dev 域名，
   * 将此 Worker 当作公共反向代理使用。
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
    /**
     * 默认响应只包含状态与时间戳。
     *
     * 上游列表属于部署拓扑信息，仅在诊断模式开启时附带。
     */
    const payload = {
      status: "ok",
      service: "cloudflare-worker-reverse-proxy",
      publicHost,
      timestamp: new Date().toISOString(),
    };

    if (config.addDiagnosticHeaders) {
      payload.upstreams = config.upstreamHosts;
    }

    return Response.json(payload, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
  }

  /**
   * OPTIONS 请求可能是浏览器发起的 CORS 预检请求。
   *
   * 这里仍然转发给上游，让上游应用自行决定允许哪些来源、
   * 方法和请求头，避免 Worker 无条件放宽安全限制。
   */

  const upstreamHost = selectUpstream(config.upstreamHosts);

  /**
   * 复制原始 URL。
   *
   * 原始路径和查询参数都会完整保留，只替换协议、主机名和端口。
   */
  const upstreamUrl = new URL(incomingUrl.toString());

  upstreamUrl.protocol = config.upstreamProtocol;
  upstreamUrl.hostname = upstreamHost;
  upstreamUrl.port = config.upstreamPort;

  const upstreamRequest = buildUpstreamRequest({
    request,
    incomingUrl,
    upstreamUrl,
    publicHost,
    upstreamHost,
    config,
  });

  /**
   * 创建超时控制器。
   *
   * 只约束"等待上游响应头"的时间；响应体开始返回后即解除，
   * 不会中断流式传输（SSE / 大文件下载 / WebSocket 均不受影响）。
   */
  const abortController = new AbortController();

  const timeoutId = setTimeout(() => {
    abortController.abort("上游请求超时");
  }, config.upstreamTimeoutMs);

  let upstreamResponse;

  try {
    /**
     * 使用 manual 模式禁止自动跟随重定向。
     *
     * 这样 Worker 才能取得上游的 Location 响应头，并将其中的
     * 上游域名改写回对外域名。
     */
    upstreamResponse = await fetch(upstreamRequest, {
      redirect: "manual",
      signal: abortController.signal,
    });
  } catch (error) {
    if (
      error?.name === "AbortError" ||
      abortController.signal.aborted
    ) {
      console.error(
        JSON.stringify({
          event: "upstream_timeout",
          upstreamUrl: upstreamUrl.toString(),
          timeoutMs: config.upstreamTimeoutMs,
        }),
      );

      return createErrorResponse(
        504,
        "Gateway Timeout",
        "upstream-timeout",
      );
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
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
    upstreamHost,
    config,
  });
}

/**
 * 构建由 Worker 发往上游的请求。
 *
 * @param {object} params
 * @returns {Request}
 */
function buildUpstreamRequest({
  request,
  incomingUrl,
  upstreamUrl,
  publicHost,
  upstreamHost,
  config,
}) {
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

  /**
   * 某些上游应用会检查 Origin 和 Referer。
   *
   * 如果其中的主机名是公开代理域名，则将其改写为上游域名；
   * 如果是第三方域名，则保持不变。
   */
  if (config.rewriteRequestOrigin) {
    rewriteRequestHeaderUrl(
      headers,
      "origin",
      publicHost,
      upstreamHost,
      config.upstreamProtocol,
      config.upstreamPort,
    );

    rewriteRequestHeaderUrl(
      headers,
      "referer",
      publicHost,
      upstreamHost,
      config.upstreamProtocol,
      config.upstreamPort,
    );
  }

  /**
   * 根据新的上游 URL 和原始 Request 构造转发请求。
   *
   * 这样可以保留：
   * - HTTP 方法
   * - 请求体
   * - Content-Type
   * - Authorization
   * - Cookie
   * - WebSocket Upgrade 请求头
   * - 其他客户端请求头
   */
  return new Request(upstreamUrl.toString(), request, {
    headers,
    redirect: "manual",
  });
}

/**
 * 构建返回给客户端的响应。
 *
 * @param {object} params
 * @returns {Response}
 */
function buildClientResponse({
  upstreamResponse,
  incomingUrl,
  publicHost,
  upstreamHost,
  config,
}) {
  /**
   * 复制上游响应头。
   *
   * Set-Cookie 需要单独处理，不能与其他响应头使用相同逻辑复制。
   */
  const headers = copyResponseHeaders(
    upstreamResponse.headers,
  );

  /**
   * 将上游重定向地址中的上游域名改写为公开域名。
   */
  if (config.rewriteLocation) {
    rewriteLocationHeader({
      headers,
      incomingUrl,
      publicHost,
      upstreamHost,
      config,
    });
  }

  /**
   * 复制并处理所有 Set-Cookie 响应头。
   */
  if (config.rewriteCookies) {
    rewriteSetCookieHeaders({
      targetHeaders: headers,
      sourceHeaders: upstreamResponse.headers,
      publicHost,
      cookieDomainMode: config.cookieDomainMode,
    });
  } else {
    copySetCookieHeaders(
      headers,
      upstreamResponse.headers,
    );
  }

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
      upstreamHost,
    );
  }

  /**
   * 错误响应和动态请求不进行浏览器缓存。
   *
   * 正常静态资源是否缓存，继续遵循上游返回的 Cache-Control。
   */
  if (upstreamResponse.status >= 400) {
    headers.set("Cache-Control", "no-store");
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}

/**
 * 复制普通响应头，但跳过 Set-Cookie。
 *
 * 多个 Set-Cookie 必须保持为多个独立响应头，不能使用逗号合并。
 *
 * @param {Headers} sourceHeaders
 * @returns {Headers}
 */
function copyResponseHeaders(sourceHeaders) {
  const targetHeaders = new Headers();

  for (const [name, value] of sourceHeaders.entries()) {
    if (name.toLowerCase() !== "set-cookie") {
      targetHeaders.append(name, value);
    }
  }

  return targetHeaders;
}

/**
 * 改写上游返回的 Location 响应头。
 *
 * 例如：
 * https://upstream.example.com/login
 * 改写为：
 * https://example.com/login
 *
 * 指向其他第三方域名的跳转不会被修改。
 *
 * @param {object} params
 */
function rewriteLocationHeader({
  headers,
  incomingUrl,
  publicHost,
  upstreamHost,
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
      `${config.upstreamProtocol}//${upstreamHost}`,
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
function rewriteSetCookieHeaders({
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
function copySetCookieHeaders(
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
function getSetCookieValues(headers) {
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

/**
 * 改写请求中的 Origin 或 Referer。
 *
 * 只有请求头中的主机名等于公开代理域名时才进行改写。
 * 第三方来源保持不变。
 *
 * @param {Headers} headers
 * @param {string} headerName
 * @param {string} publicHost
 * @param {string} upstreamHost
 * @param {string} upstreamProtocol
 * @param {string} upstreamPort
 */
function rewriteRequestHeaderUrl(
  headers,
  headerName,
  publicHost,
  upstreamHost,
  upstreamProtocol,
  upstreamPort,
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
      headerUrl.protocol = upstreamProtocol;
      headerUrl.hostname = upstreamHost;
      headerUrl.port = upstreamPort;

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

/**
 * 从上游列表中随机选择一个域名。
 *
 * 当前只有一个上游时，总是返回同一个域名。
 *
 * 注意：当前不支持多上游故障转移。如果配置了多个上游，
 * 某个上游不可用时该请求会直接失败（502），不会自动
 * 重试其余节点。多上游场景请配合外部健康检查使用。
 *
 * @param {string[]} upstreams
 * @returns {string}
 */
function selectUpstream(upstreams) {
  if (
    !Array.isArray(upstreams) ||
    upstreams.length === 0
  ) {
    throw new Error("未配置任何上游域名");
  }

  const index = Math.floor(
    Math.random() * upstreams.length,
  );

  return upstreams[index];
}

/**
 * 创建统一格式的错误响应。
 *
 * @param {number} status HTTP 状态码
 * @param {string} message 对外显示的信息
 * @param {string} errorCode 内部错误代码
 * @returns {Response}
 */
function createErrorResponse(
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
