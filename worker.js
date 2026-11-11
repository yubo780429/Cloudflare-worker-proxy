/**
 * Cloudflare Worker 反向代理 —— ES Module 入口。
 *
 * 本文件只做三件事：加载配置、调用应用层编排、兜底顶层异常。
 * 具体职责见 src/：
 *   app/      请求生命周期编排
 *   config/   默认配置 / 解析 / 校验
 *   routing/  上游选择
 *   proxy/    请求构造 / 上游 fetch + TTFB / 响应构造
 *   headers/  请求头与响应头策略
 *   rewrite/  Location / Set-Cookie / Origin-Referer 改写
 *   http/     统一错误响应与健康检查
 *
 * 功能说明、配置表与验证结论见 README.md。
 * wrangler.toml 的 main 仍指向本文件，无需改动部署配置。
 */
import { loadConfig } from "./src/config/load-config.js";
import { handleRequest } from "./src/app/handle-request.js";
import { createErrorResponse, redactUrl } from "./src/http/errors.js";

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
       * URL 只记录 origin + 路径，查询串一律剔除——
       * 查询串可能携带 token（如 ?token=...、DoH 的 ?dns=...），
       * 明文进日志属于凭证泄露。
       */
      console.error(
        JSON.stringify({
          event: "proxy_unhandled_error",
          method: request.method,
          url: redactUrl(request.url),
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
