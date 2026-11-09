/**
 * Cloudflare Worker 反向代理
 *
 * 对外访问域名：
 *   proxy.example.com
 *
 * 上游应用域名：
 *   my-app.vercel.app
 *
 * 主要功能：
 * 1. 保留原请求的方法、路径、查询参数和请求体
 * 2. 将请求转发到指定的 Vercel 应用
 * 3. 将上游重定向地址改写回对外访问域名
 * 4. 处理上游 Set-Cookie 中的 Domain 属性
 * 5. 根据需要改写 Origin 和 Referer
 * 6. 支持 WebSocket 升级请求
 * 7. 限制允许访问的入口域名，避免成为开放代理
 * 8. 提供健康检查接口
 * 9. 提供上游请求超时控制
 */

/**
 * Worker 配置。
 *
 * 如果以后需要增加多个 Vercel 上游，可以继续向 upstreamHosts
 * 数组中添加域名。
 */
const CONFIG = {
  /**
   * 允许访问此 Worker 的对外域名。
   *
   * 请求的 HTTP Host 必须在此列表中，否则返回 421。
   */
  allowedHosts: [
    "proxy.example.com",
  ],

  /**
   * 上游应用域名列表。
   *
   * 不要填写 https://，也不要包含路径。
   */
  upstreamHosts: [
    "my-app.vercel.app",
  ],

  /**
   * 是否将上游的绝对重定向地址改写回对外域名。
   *
   * 例如：
   * https://my-app.vercel.app/login
   *
   * 改写为：
   * https://proxy.example.com/login
   */
  rewriteLocation: true,

  /**
   * 是否处理上游响应中的 Set-Cookie。
   *
   * 如果上游 Cookie 明确指定：
   * Domain=my-app.vercel.app
   *
   * Worker 会移除该 Domain 属性，使 Cookie 成为当前对外域名的
   * Host-only Cookie。
   */
  rewriteCookies: true,

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
   * 调试完成后，如果不想暴露上游信息，可以改成 false。
   */
  addDiagnosticHeaders: true,

  /**
   * 上游请求最长等待时间，单位为毫秒。
   *
   * 这里设置为 30 秒。
   */
  upstreamTimeoutMs: 30000,

  /**
   * 是否允许健康检查接口。
   *
   * 健康检查地址：
   * https://proxy.example.com/__proxy_health
   */
  enableHealthCheck: true,
};

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
    try {
      return await handleRequest(request);
    } catch (error) {
      console.error("反向代理发生未处理异常：", error);

      return createErrorResponse(
        502,
        "Bad Gateway",
        "upstream-request-failed",
      );
    }
  },
};

/**
 * 处理客户端传入的请求。
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function handleRequest(request) {
  const incomingUrl = new URL(request.url);
  const publicHost = incomingUrl.hostname.toLowerCase();

  /**
   * 限制入口域名。
   *
   * 这样可以避免别人通过其他绑定域名或 workers.dev 域名，
   * 将此 Worker 当作公共反向代理使用。
   */
  if (!CONFIG.allowedHosts.includes(publicHost)) {
    return createErrorResponse(
      421,
      "Misdirected Request",
      "host-not-allowed",
    );
  }

  /**
   * Worker 自身的健康检查接口。
   *
   * 此请求不会被转发到 Vercel。
   */
  if (
    CONFIG.enableHealthCheck &&
    incomingUrl.pathname === "/__proxy_health" &&
    request.method === "GET"
  ) {
    return Response.json(
      {
        status: "ok",
        service: "cloudflare-worker-reverse-proxy",
        publicHost,
        upstreams: CONFIG.upstreamHosts,
        timestamp: new Date().toISOString(),
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
          "X-Robots-Tag": "noindex, nofollow",
        },
      },
    );
  }

  /**
   * OPTIONS 请求可能是浏览器发起的 CORS 预检请求。
   *
   * 这里仍然转发给上游，让上游应用自行决定允许哪些来源、
   * 方法和请求头，避免 Worker 无条件放宽安全限制。
   */

  const upstreamHost = selectUpstream(CONFIG.upstreamHosts);

  /**
   * 复制原始 URL。
   *
   * 原始路径和查询参数都会完整保留，只替换协议、主机名和端口。
   */
  const upstreamUrl = new URL(incomingUrl.toString());

  upstreamUrl.protocol = "https:";
  upstreamUrl.hostname = upstreamHost;
  upstreamUrl.port = "";

  const upstreamRequest = buildUpstreamRequest({
    request,
    incomingUrl,
    upstreamUrl,
    publicHost,
    upstreamHost,
  });

  /**
   * 创建超时控制器。
   *
   * 如果上游在指定时间内没有完成响应，则终止本次请求。
   */
  const abortController = new AbortController();

  const timeoutId = setTimeout(() => {
    abortController.abort("上游请求超时");
  }, CONFIG.upstreamTimeoutMs);

  let upstreamResponse;

  try {
    /**
     * 使用 manual 模式禁止自动跟随重定向。
     *
     * 这样 Worker 才能取得上游的 Location 响应头，并将其中的
     * Vercel 域名改写回对外域名。
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
      console.error("上游请求超时：", upstreamUrl.toString());

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
}) {
  const headers = new Headers(request.headers);

  /**
   * 删除客户端传入的 Host。
   *
   * Worker 会根据 upstreamUrl.hostname 自动使用正确的上游主机名，
   * 避免 Vercel 收到 proxy.example.com 作为内部请求目标。
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
  if (CONFIG.rewriteRequestOrigin) {
    rewriteRequestHeaderUrl(
      headers,
      "origin",
      publicHost,
      upstreamHost,
    );

    rewriteRequestHeaderUrl(
      headers,
      "referer",
      publicHost,
      upstreamHost,
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
   * 将上游重定向地址中的 Vercel 域名改写为公开域名。
   */
  if (CONFIG.rewriteLocation) {
    rewriteLocationHeader({
      headers,
      incomingUrl,
      publicHost,
      upstreamHost,
    });
  }

  /**
   * 复制并处理所有 Set-Cookie 响应头。
   */
  if (CONFIG.rewriteCookies) {
    rewriteSetCookieHeaders({
      targetHeaders: headers,
      sourceHeaders: upstreamResponse.headers,
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
   * 删除可能已经失效的 Content-Length。
   *
   * Worker 返回流式响应时会自行处理响应长度。如果以后增加正文
   * 替换功能，保留旧 Content-Length 可能造成响应截断。
   */
  headers.delete("content-length");

  /**
   * 可选的诊断响应头。
   *
   * 如果不希望客户端看到上游域名，可以将配置中的
   * addDiagnosticHeaders 改为 false。
   */
  if (CONFIG.addDiagnosticHeaders) {
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
 * https://my-app.vercel.app/login
 *
 * 改写为：
 * https://proxy.example.com/login
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
      `https://${upstreamHost}`,
    );

    const redirectHost =
      redirectUrl.hostname.toLowerCase();

    /**
     * 只有跳转目标属于已配置的上游域名时才进行改写。
     *
     * OAuth、支付平台等外部跳转保持原样。
     */
    if (CONFIG.upstreamHosts.includes(redirectHost)) {
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
      "无法解析上游 Location 响应头：",
      location,
      error,
    );
  }
}

/**
 * 复制并改写所有 Set-Cookie 响应头。
 *
 * 如果上游 Cookie 包含：
 * Domain=my-app.vercel.app
 *
 * 则移除 Domain 属性。
 *
 * 浏览器从 proxy.example.com 收到不带 Domain 的 Cookie 后，
 * 会将它作为 proxy.example.com 的 Host-only Cookie。
 *
 * @param {object} params
 */
function rewriteSetCookieHeaders({
  targetHeaders,
  sourceHeaders,
}) {
  targetHeaders.delete("set-cookie");

  const cookies = getSetCookieValues(sourceHeaders);

  for (const originalCookie of cookies) {
    /**
     * 移除任意显式 Domain 属性。
     *
     * 这里不直接替换成公开域名，而是移除 Domain，使 Cookie
     * 成为更严格的 Host-only Cookie。
     */
    const rewrittenCookie = originalCookie.replace(
      /;\s*Domain\s*=\s*[^;]+/gi,
      "",
    );

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
 */
function rewriteRequestHeaderUrl(
  headers,
  headerName,
  publicHost,
  upstreamHost,
}) {
  const value = headers.get(headerName);

  if (!value || value === "null") {
    return;
  }

  try {
    const headerUrl = new URL(value);

    if (
      headerUrl.hostname.toLowerCase() === publicHost
    ) {
      headerUrl.protocol = "https:";
      headerUrl.hostname = upstreamHost;
      headerUrl.port = "";

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
