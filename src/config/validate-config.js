/**
 * 配置项的解析与校验（纯函数，不持有状态）。
 *
 * 从原 worker.js 的 loadConfig 内部助手逐字搬移。为保持可测试性，
 * 所有"告警"都通过调用方注入的 warn(field, value, reason) 回调发出；
 * 函数本身只接收参数、返回规范化结果，不读取环境变量、不写日志。
 *
 * 行为约定（不可改变）：非法值一律「告警 + 回落默认值」，不抛错、
 * 不终止请求。生产模式快速失败属于后续改进计划，不在本次拆分范围。
 */

/**
 * 解析布尔值。只接受 "true" / "false"（不区分大小写），
 * 其他非空值告警并按默认值处理——避免 "treu"、"1"、"yes"
 * 这类笔误被静默解释为 false。
 */
export function parseBool(value, fallback, field, warn) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  warn(field, value, `无法识别的布尔值，已按默认值 ${fallback} 处理（只接受 true/false）`);
  return fallback;
}

/** 解析逗号分隔的域名列表，统一转小写。 */
export function parseList(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return String(value)
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

/** 解析正整数，非法值回落到默认值。 */
export function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : fallback;
}

/**
 * 规范化协议写法，保证带冒号（URL.protocol 需要）。
 * 只接受 http / https，其他值告警并回落默认。
 */
export function normalizeProtocol(value, fallback, warn) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const proto = String(value).toLowerCase().trim();
  if (proto !== "http" && proto !== "https" &&
      proto !== "http:" && proto !== "https:") {
    warn("PROXY_UPSTREAM_PROTOCOL", value, "只支持 http/https，已按默认值处理");
    return fallback;
  }
  return proto.endsWith(":") ? proto : `${proto}:`;
}

/**
 * 校验端口：必须是 1-65535 的数字；非法值告警并视为未设置
 * （回落协议默认端口）。
 */
export function normalizePort(value, warn) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return "";
  }
  const raw = String(value).trim();
  const num = Number(raw);
  if (!Number.isInteger(num) || num < 1 || num > 65535) {
    warn("PROXY_UPSTREAM_PORTS", raw, "端口必须是 1-65535 的整数，已按协议默认端口处理");
    return "";
  }
  return String(num);
}

/** 解析 Cookie Domain 处理模式，非法值告警并回落 strip。 */
export function parseCookieDomainMode(raw, warn) {
  if (raw === "rewrite") return "rewrite";
  if (raw === "" || raw === "strip") return "strip";
  warn("PROXY_COOKIE_DOMAIN_MODE", raw, "只支持 strip/rewrite，已按 strip 处理");
  return "strip";
}

/**
 * 按逗号拆分但保留空项（不转小写之外的加工），
 * 用于与上游列表按索引对齐的并行变量：
 * 空项表示"该位置不设置此属性"。
 */
export function parseParallel(value) {
  if (value === undefined || value === null || value === "") {
    return [];
  }
  return String(value)
    .split(",")
    .map((item) => item.trim().toLowerCase());
}

/**
 * 校验三组并行上游配置：长度对齐 + 路由域名必须落在入口白名单内。
 * 只告警，不修改列表、不抛错。
 */
export function validateUpstreamLists({ hosts, ports, publicHosts, allowedHosts, warn }) {
  /**
   * 并行列表长度应与 HOSTS 一致。多出/不足都不该静默：
   * 多余的项永远不会被读取，缺项意味着该位置用默认值——
   * 都可能意味着配置错位。
   */
  if (ports.length > 0 && ports.length !== hosts.length) {
    warn(
      "PROXY_UPSTREAM_PORTS",
      `${ports.length} 项`,
      `与 PROXY_UPSTREAM_HOSTS 的 ${hosts.length} 项数量不一致，按序号对齐后可能路由错位`,
    );
  }
  if (publicHosts.length > 0 && publicHosts.length !== hosts.length) {
    warn(
      "PROXY_PUBLIC_HOSTS",
      `${publicHosts.length} 项`,
      `与 PROXY_UPSTREAM_HOSTS 的 ${hosts.length} 项数量不一致，按序号对齐后可能路由错位`,
    );
  }

  /**
   * PUBLIC_HOSTS 的非空项必须在 ALLOWED_HOSTS 白名单内，
   * 否则该路由在入口 421 处就已被拦截，永远不可达。
   */
  for (const ph of publicHosts) {
    if (ph && !allowedHosts.includes(ph)) {
      warn(
        "PROXY_PUBLIC_HOSTS",
        ph,
        "该域名不在 PROXY_ALLOWED_HOSTS 白名单内，对应路由永远不可达（入口已 421）",
      );
    }
  }
}
