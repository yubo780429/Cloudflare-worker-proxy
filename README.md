# Cloudflare Worker 反向代理脚本

基于 Cloudflare Worker 的高性能全功能反向代理脚本。专门优化了针对 Vercel / Next.js 等全栈平台及现代 Web 应用的反向代理体验，支持 Cookie 作用域修复、重定向改写、防跨域/CSRF 拦截、WebSocket 穿透及防止成为开放代理。

---

## ⚡ 核心功能

1. **完整转发**：保留原始请求方法（GET/POST/PUT 等）、路径、Query 参数、请求体及 Header。
2. **重定向修正**：自动将上游响应中的 `Location` 绝对地址重定向改写回对外域名。
3. **Cookie 作用域修复**：自动剔除上游 `Set-Cookie` 中的 `Domain` 属性，将其转换为当前对外域名的 Host-only Cookie，解决登录态丢失问题。
4. **防 CSRF / 跨域拦截**：自动将发往上游请求的 `Origin` 与 `Referer` 改写为上游域名（完美兼容 Next.js Server Actions 与各类 CSRF 防护）。
5. **WebSocket 穿透**：检测到 `101 Switching Protocols` 升级响应时直接无损透传。
6. **防开放代理滥用**：内置访问域名白名单机制，非允许域名访问直接返回 `421 Misdirected Request`。
7. **客户端真实 IP 传递**：清洗伪造的转发头，使用 Cloudflare 可信节点 IP 注入 `X-Forwarded-For`。
8. **超时熔断控制**：内置 `AbortController`，上游无响应超过设定时间自动熔断并返回 `504 Gateway Timeout`。
9. **内置健康检查**：提供边缘直接响应的健康检测接口，不消耗源站流量。

---

## ⚠️ 部署前必改配置（必读）

将脚本复制到 Worker 之后，**必须根据实际情况修改脚本顶部的 `CONFIG` 对象**：

```javascript
const CONFIG = {
  /**
   * 【必须修改】允许访问此 Worker 的对外域名（你的自定义域名）
   * 客户端请求的 HTTP Host 必须匹配，否则会返回 421，避免 Worker 被他人当成免费公共代理。
   */
  allowedHosts: [
    "example.com", // 👈 改为你的对外访问域名，例如："proxy.yourdomain.com"
  ],

  /**
   * 【必须修改】实际的上游应用域名列表
   * ⚠️ 注意：切勿包含协议头（https://）及任何路径（/）。
   */
  upstreamHosts: [
    "upstream.example.com", // 👈 改为你的真实源站，例如："my-app.vercel.app"
  ],
  
  // ... 其余选项保持默认即可，也可根据需求调整
};
