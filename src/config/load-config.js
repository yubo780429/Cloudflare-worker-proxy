/**
 * 从环境变量加载配置，未设置的环境变量回落到默认值。
 *
 * 从原 worker.js 的 loadConfig 逐字搬移；告警去重集合仍是模块级单例，
 * 保证「同一 field+value 每个 isolate 只告警一次」的语义不变。
 *
 * @param {object} env Worker 环境变量
 * @returns {object}
 */
import { CONFIG_DEFAULTS } from "./defaults.js";
import {
  parseBool,
  parseList,
  parsePositiveInt,
  normalizeProtocol,
  normalizePort,
  parseCookieDomainMode,
  parseParallel,
  validateUpstreamLists,
} from "./validate-config.js";

/**
 * 已告警过的配置项集合（模块级）。
 *
 * loadConfig 在每个请求上都会执行，若不抑制重复，
 * 同一条配置告警会按请求量刷屏 Workers Logs。
 * 同一字段同一非法值只告警一次（冷启动后首个请求）。
 */
const configWarnedKeys = new Set();

export function loadConfig(env) {
  const e = env || {};

  /**
   * 配置告警：结构化输出，便于在 Workers Logs / Logpush 中检索。
   * 所有"值非法但已回落默认"的情况都会在这里留下痕迹，
   * 不再静默吞掉。同一 field+value 每个 isolate 只告警一次。
   */
  const warnConfig = (field, value, reason) => {
    const key = `${field}:${String(value)}`;
    if (configWarnedKeys.has(key)) {
      return;
    }
    configWarnedKeys.add(key);
    console.warn(
      JSON.stringify({
        event: "config_warning",
        field,
        value: String(value),
        reason,
      }),
    );
  };

  const warn = warnConfig;

  const cookieDomainModeRaw = String(e.PROXY_COOKIE_DOMAIN_MODE || "").trim().toLowerCase();
  const cookieDomainMode = parseCookieDomainMode(cookieDomainModeRaw, warn);

  /**
   * 解析上游配置：三组并行变量按索引一一对应。
   *
   *   PROXY_UPSTREAM_HOSTS = 10.0.0.2,10.0.0.2
   *   PROXY_UPSTREAM_PORTS = 9090,20252
   *   PROXY_PUBLIC_HOSTS   = app.example.com,nas.example.com
   *
   * 即：第 1 个上游 = app.example.com → 10.0.0.2:9090
   *     第 2 个上游 = nas.example.com → 10.0.0.2:20252
   *
   * 留空规则（不填 = 保持 Cloudflare 默认代理行为）：
   *   PORTS 某项为空        → 协议默认端口（443 / 80）
   *   PUBLIC_HOSTS 某项为空 → 通配，任何对外域名都可路由到该上游
   *   PROXY_UPSTREAM_PROTOCOL 不设置 → 全局 https
   *   全部不设置            → 使用代码内默认配置
   */
  const parseUpstreams = () => {
    const hosts = parseList(e.PROXY_UPSTREAM_HOSTS, null);

    if (!hosts || hosts.length === 0) {
      return CONFIG_DEFAULTS.upstreams;
    }

    const protocol = normalizeProtocol(
      e.PROXY_UPSTREAM_PROTOCOL,
      CONFIG_DEFAULTS.upstreams[0].protocol,
      warn,
    );

    /**
     * 端口并行列表；兼容更早版本的单端口变量 PROXY_UPSTREAM_PORT
     * （设置后对列表中所有上游生效）。
     */
    let ports = parseParallel(e.PROXY_UPSTREAM_PORTS);
    if (
      ports.length === 0 &&
      e.PROXY_UPSTREAM_PORT !== undefined &&
      e.PROXY_UPSTREAM_PORT !== null &&
      e.PROXY_UPSTREAM_PORT !== ""
    ) {
      ports = hosts.map(() => String(e.PROXY_UPSTREAM_PORT).trim());
    }

    const publicHosts = parseParallel(e.PROXY_PUBLIC_HOSTS);

    validateUpstreamLists({ hosts, ports, publicHosts, allowedHosts, warn });

    return hosts.map((host, index) => ({
      host,
      port: normalizePort(ports[index], warn),
      protocol,
      publicHost: publicHosts[index] || "",
    }));
  };

  const allowedHosts = parseList(e.PROXY_ALLOWED_HOSTS, CONFIG_DEFAULTS.allowedHosts);
  const upstreams = parseUpstreams();

  return {
    allowedHosts,
    upstreams,
    /**
     * 上游主机名列表（由配置块派生），
     * 供 Location 改写和健康检查诊断使用。
     */
    upstreamHosts: upstreams.map((entry) => entry.host),
    rewriteLocation: parseBool(e.PROXY_REWRITE_LOCATION, CONFIG_DEFAULTS.rewriteLocation, "PROXY_REWRITE_LOCATION", warn),
    rewriteCookies: parseBool(e.PROXY_REWRITE_COOKIES, CONFIG_DEFAULTS.rewriteCookies, "PROXY_REWRITE_COOKIES", warn),
    cookieDomainMode,
    rewriteRequestOrigin: parseBool(e.PROXY_REWRITE_ORIGIN, CONFIG_DEFAULTS.rewriteRequestOrigin, "PROXY_REWRITE_ORIGIN", warn),
    addDiagnosticHeaders: parseBool(e.PROXY_DIAGNOSTIC_HEADERS, CONFIG_DEFAULTS.addDiagnosticHeaders, "PROXY_DIAGNOSTIC_HEADERS", warn),
    upstreamTimeoutMs: parsePositiveInt(e.PROXY_TIMEOUT_MS, CONFIG_DEFAULTS.upstreamTimeoutMs),
    enableHealthCheck: parseBool(e.PROXY_HEALTH_CHECK, CONFIG_DEFAULTS.enableHealthCheck, "PROXY_HEALTH_CHECK", warn),
  };
}
