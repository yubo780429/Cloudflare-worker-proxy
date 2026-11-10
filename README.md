# Cloudflare Worker 全协议反向代理

一个部署在 Cloudflare Workers 上的反向代理：对外只暴露 `example.com`，流量被透明转发到上游应用 `upstream.example.com`。保留请求方法、路径、查询参数、请求体与认证信息，支持 HTTP/HTTPS、SSE、WebSocket、DoH、gRPC-Web 等协议透传。

## 功能特性

- **透明转发**：完整保留方法 / 路径 / 查询参数 / 请求体 / Cookie / Authorization
- **重定向改写**：上游 `Location` 中指向上游域名的绝对跳转自动改写回对外域名；OAuth、支付等第三方跳转原样保留
- **Cookie 处理**：`Set-Cookie` 的 `Domain` 属性可拆除（默认，Host-only，更安全）或改写为对外域名（多子域共享登录态）
- **Origin / Referer 改写**：减少上游 CSRF / 来源校验导致的 403
- **WebSocket 支持**：101 升级响应直通，长连接不受超时控制影响
- **开放代理防护**：入口域名白名单，非白名单 Host 返回 421
- **TTFB 超时**：上游无响应 30 秒（可配）返回 504；拿到响应头后即解除，不中断流式传输
- **健康检查**：`GET /__proxy_health`，默认不泄露上游拓扑信息
- **零配置改码部署**：全部配置项支持环境变量覆盖，同一份代码部署多环境

## 快速开始

### 1. 准备 wrangler.toml

```toml
name = "reverse-proxy"
main = "worker.js"
compatibility_date = "2026-11-11"

[vars]
# 允许访问本 Worker 的对外域名（逗号分隔）
PROXY_ALLOWED_HOSTS = "app.example.com,nas.example.com"
# 上游配置：三组并行变量按序号一一对应（1→1、2→2）
# 下面表示：app.example.com → 10.0.0.2:9090，nas.example.com → 10.0.0.2:20252
PROXY_UPSTREAM_HOSTS = "10.0.0.2,10.0.0.2"
PROXY_UPSTREAM_PORTS = "9090,20252"
PROXY_PUBLIC_HOSTS = "app.example.com,nas.example.com"
# 上游为 http 时设一次即可；不设置默认 https
PROXY_UPSTREAM_PROTOCOL = "http"
```

### 2. 本地开发

本地变量文件是 `.dev.vars`（复制 `.dev.vars.example` 修改；不要用 `.env`，wrangler 不会把它注入 Worker 绑定）：

```bash
npx wrangler@3 dev worker.js --ip 127.0.0.1 --port 8787
```

### 3. 部署

```bash
npx wrangler@3 deploy
```

部署后在 Cloudflare 控制台把 `example.com` 的 DNS 记录（橙色云）指向该 Worker 的路由，上游应用只需放行来自 Cloudflare 的请求。

## 配置项

所有配置通过环境变量（`[vars]`）设置，未设置时使用代码内默认值：

| 环境变量                       | 默认值                    | 说明                                                                                                     |
| -------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `PROXY_ALLOWED_HOSTS`      | `example.com`          | 对外域名白名单：客户端请求的 Host 必须在列表中，否则 421。**留空 ≠ 放行所有，而是回落到占位域名 `example.com`，真实请求全部 421**。详见下方"对外域名白名单与路由的关系" |
| `PROXY_UPSTREAM_HOSTS`     | `upstream.example.com` | 上游主机域名/IP 列表，逗号分隔；不要带协议和路径                                                                             |
| `PROXY_UPSTREAM_PORTS`     | 空                      | 上游端口列表，与 `PROXY_UPSTREAM_HOSTS` **按序号一一对应**；某项留空 = 协议默认端口。支持 9090/20252 等非标端口                          |
| `PROXY_PUBLIC_HOSTS`       | 空                      | 每个上游只服务哪个对外域名，与 HOSTS 按序号对齐；某项留空 = 通配（任何域名可路由到它）                                                       |
| `PROXY_UPSTREAM_PROTOCOL`  | `https`                | 访问上游的协议（全局统一，`https` / `http`）；不设置 = https                                                             |
| `PROXY_UPSTREAM_PORT`      | 空                      | 旧版单端口变量（兼容用）：设置后对**所有**上游生效，优先级低于 `PROXY_UPSTREAM_PORTS`                                               |
| `PROXY_TIMEOUT_MS`         | `30000`                | 等待上游响应头的最长时间（毫秒），超时返回 504；不约束响应体流式传输                                                                   |
| `PROXY_REWRITE_LOCATION`   | `true`                 | 是否将上游重定向地址改写回对外域名                                                                                      |
| `PROXY_REWRITE_COOKIES`    | `true`                 | 是否处理上游 Set-Cookie 的 Domain 属性                                                                          |
| `PROXY_COOKIE_DOMAIN_MODE` | `strip`                | Cookie Domain 处理模式：`strip`（移除，Host-only，更安全）/ `rewrite`（改写为对外域名，多子域共享登录态用）                             |
| `PROXY_REWRITE_ORIGIN`     | `true`                 | 是否将请求中的 Origin / Referer 从对外域名改写为上游域名                                                                  |
| `PROXY_DIAGNOSTIC_HEADERS` | `false`                | 诊断模式：添加 `X-Reverse-Proxy-*` 响应头，健康检查附带上游配置。**会暴露上游域名与端口，仅排查问题时临时开启**                                   |
| `PROXY_HEALTH_CHECK`       | `true`                 | 是否启用 `GET /__proxy_health` 健康检查                                                                        |

## 对外域名白名单与路由的关系（`PROXY_ALLOWED_HOSTS` 必读）

这个变量容易困惑，一次说清：**它既是"对外提供反代的 HOST 域名"，也是"允许通过的白名单"——同一份列表，两个视角。你打算让用户通过哪些域名访问这个 Worker，就填哪些域名。**

请求到达上游之前要过两道闸，缺一不可：

| 层                                        | 在哪配置                          | 作用                   |
| ---------------------------------------- | ----------------------------- | -------------------- |
| ① Cloudflare 路由（Routes / workers.dev 子域） | Dashboard → Worker → 设置 → 触发器 | 决定请求**能不能到达** Worker |
| ② `PROXY_ALLOWED_HOSTS` 白名单              | 环境变量（本 Worker 代码内检查）          | 决定到达的请求**是否被放行**转发   |

请求先过①再过②。常见的两种"配了却不通"：

- **只配①没配②**：路由把 `example.com` 的流量送进了 Worker，但白名单里没有它 → 全部 421。
- **只配②没配①**：白名单放行了，但 Cloudflare 边缘根本没把该域名的流量路由给 Worker → 请求根本到不了代码。

**留空/不设置的后果**：代码回落到默认占位值 `example.com`。这不是"关闭白名单、放行所有"，而是"白名单里只有你根本用不上的 example.com"——你的真实域名全部 421。**所以它是必填项，不能留空。**

按场景填法：

| 场景                                                   | 填法                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| 只用 workers.dev 域名（如 `reverse-proxy.xxx.workers.dev`） | `PROXY_ALLOWED_HOSTS = reverse-proxy.xxx.workers.dev`                           |
| 绑定了自定义域名                                             | 把自定义域名加进来，如 `.example.com,reverse-proxy.xxx.workers.dev`（workers.dev 是否保留随你） |
| 多域名对应多上游                                             | 白名单管"放不放行"，`PROXY_PUBLIC_HOSTS` 管"路由到哪个上游"。白名单是入口安检，PUBLIC_HOSTS 是分流，两者都别漏      |

与安全的联动：白名单是防止 Worker 被当公共开放代理滥用的最后一道防线。即使路由配置失误把无关域名指了进来，白名单也会用 421 挡住。

## 非标准端口反代（9090 / 20252 等）

**端口映射发生在 Worker → 上游一段，客户端永远走 443。**

```
https://app.example.com/api  →（443 进入 Cloudflare 边缘）→  Worker  →  http://10.0.0.2:9090/api
https://nas.example.com/web  →（443 进入 Cloudflare 边缘）→  Worker  →  http://10.0.0.2:20252/web
```

可行性与限制（已实测验证路由与透传）：

- **Workers 的 fetch 子请求不受 Cloudflare 回源端口白名单限制**，可以访问任意上游端口（本方案的基础）。
- **客户端不能直连 `example.com:9090`**——Cloudflare 边缘只监听 443/2053/2083/2087/2096/8443 等 HTTP(S) 端口，非标端口的入口流量在边缘就被拒绝，与 Worker 无关。
- **多端口 = 多服务时，必须在 `PROXY_PUBLIC_HOSTS` 中给每个上游指定对外域名**。否则通配池随机选择会把请求打到错误的服务。
- 只覆盖 HTTP 家族协议（HTTP/WebSocket/SSE/gRPC-Web）。裸 TCP/UDP 请用 Cloudflare Spectrum（付费）。
- 替代方案对比：Origin Rules 可静态改写回源端口但做不了 Cookie/Location 改写；Spectrum 支持任意入口端口但按流量计费；DNS 直连（灰云）等于放弃代理。

## 协议支持与验证结论

以下结论来自实际测试（wrangler dev / workerd 运行时 + 自建上游逐项实测，环境与用例见仓库 `proxy-verify/`）：

| 协议 / 场景                   | 经代理结果  | 说明                                         |
| ------------------------- | ------ | ------------------------------------------ |
| HTTP / HTTPS 常规请求         | ✅ 完全可用 | 含请求体、二进制、gzip、Range/断点续传（Content-Range 保留） |
| SSE / 长轮询                 | ✅ 完全可用 | TTFB 超时不中断流式响应                             |
| WebSocket（含长连接）           | ✅ 完全可用 | 101 直通；连接静默 33s 后仍正常收发，不被超时杀死              |
| DoH（RFC 8484，POST + GET）  | ✅ 完全可用 | 二进制 DNS 报文、Content-Type 端到端无损              |
| gRPC-Web                  | ✅ 完全可用 | grpc-status 编码在正文尾帧，透传无损                   |
| gRPC trailers-only 形态     | ✅ 可用   | grpc-status 在响应头，可透传                       |
| 原生 gRPC（application/grpc） | ❌ 不可用  | 见下方"已知限制"                                  |

## 已知限制

1. **原生 gRPC 不可用（运行时能力边界，非代码问题）**。workerd 的 `Response` API 不支持 HTTP trailers，上游放在 END-TRAILERS 的 `grpc-status` 会凭空丢失；且 workerd 出站 fetch 使用 HTTP/1.1，无法与 h2-only 的 gRPC 服务器握手。实测还发现：上游返回带 HTTP/1.1 trailers 的响应后，紧邻的下一个复用连接的请求会稳定 502（workerd 连接池行为），该问题无法在 Worker 代码内修复。**替代方案**：浏览器场景改用 gRPC-Web；服务端场景在上游前部署 gRPC-Web 网关（如 Envoy / grpcwebproxy）。
2. **不改写响应正文**。上游 HTML / JS 中若硬编码了上游域名的绝对 URL，代理后这些链接会直连或失效。上游 CSP 中的 `connect-src` / `script-src` 若显式列了上游域名同样会绕过代理。部署前建议检查页面产物中是否出现上游域名。如必须支持，可在此架构上用 `HTMLRewriter` 流式改写（复杂度与 CPU 开销显著增加）。
3. **多上游无故障转移**。配置多个上游时按随机选择，某个上游不可用该请求直接 502，不会重试其余节点。多上游场景请配合外部健康检查。
4. **上游需要正确处理 `X-Forwarded-*`**。Worker 会传递 `X-Forwarded-Host` / `X-Forwarded-Proto` / `X-Forwarded-For`（来自 `CF-Connecting-IP`，不可伪造），上游应用如需生成绝对链接应读取这些头。

## 安全说明

- **入口白名单**：只允许配置的对外域名访问，防止 Worker 被当作公共开放代理。
- **上游信息隐藏**：默认不输出任何诊断头、健康检查不返回上游域名、上游 `Alt-Svc` 响应头一律删除（否则浏览器会尝试直连上游建立 HTTP/3，泄露并可能绕过代理）。
- **转发头防伪造**：客户端传入的 `Forwarded` / `X-Forwarded-*` / `X-Real-IP` 一律丢弃，由 Worker 重建可信值。
- **hop-by-hop 响应头清理**：`connection` / `transfer-encoding` 等逐跳头不透传给客户端。
- 如需进一步增强，建议在 Worker 前叠加 Cloudflare Access 或自定义鉴权逻辑（本代码不含鉴权）。

## 目录结构

```
cloudflare-reverse-proxy/
├── worker.js           # Worker 全部逻辑（单文件，零依赖）
├── .dev.vars.example   # 本地变量示例（复制为 .dev.vars 使用）
└── README.md           # 本文档

proxy-verify/      # 验证与复现环境（上游服务器 + 三协议测试客户端 + 验证报告）
```

## 本地验证复现

```bash
# 1. 启动测试上游（WS 回显 / DoH / gRPC 三形态端点，零依赖）
node proxy-verify/upstream-server.js

# 2. 用环境变量覆盖启动 Worker（无需改代码）
npx wrangler@3 dev cloudflare-reverse-proxy/worker.js \
  --ip 127.0.0.1 --port 8787 \
  --var PROXY_ALLOWED_HOSTS:127.0.0.1 \
  --var PROXY_UPSTREAM_HOSTS:127.0.0.1 \
  --var PROXY_UPSTREAM_PROTOCOL:http \
  --var PROXY_UPSTREAM_PORT:9301

# 3. 运行三协议测试
node proxy-verify/test-ws.js 8787     # WebSocket 回显
node proxy-verify/test-doh.js 8787    # DoH POST + GET
node proxy-verify/test-grpc.js 8787   # gRPC 三形态
```

## 版本说明

- **优化版（当前）**：基于实测结论的修订——删除 `Alt-Svc` 响应头（必修）、hop-by-hop 头显式清理、配置外置到环境变量、Cookie Domain 双模式（strip/rewrite）、健康检查与诊断头默认脱敏、TTFB 超时语义修正、结构化错误日志。
- **端口配置块版**：端口进入上游配置（`PROXY_UPSTREAMS` JSON），支持非标端口与按对外域名路由；已经 workerd 实测。
- **并行变量版（当前）**：应可维护性要求，JSON 配置改为三组并行变量（`PROXY_UPSTREAM_HOSTS` / `PROXY_UPSTREAM_PORTS` / `PROXY_PUBLIC_HOSTS`，按序号一一对应）；协议合并为全局可选变量（默认 https）；兼容旧版单端口变量。路由、通配、回落均经 workerd 实测。
