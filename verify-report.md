# Cloudflare Worker 反向代理 —— WebSocket / gRPC / DoH 可用性模拟验证报告

验证时间：2026-11-10
验证对象：被评估的反向代理 Worker 代码（worker.mjs，逻辑与生产版完全一致，仅协议/端口/域名三处本地适配）

## 一、验证方法

- **运行时**：`wrangler dev`（wrangler 3.114.17，内嵌 Miniflare + workerd）——与线上 Cloudflare Workers 同一运行时内核，结论对线上有效。
- **测试上游**：零依赖 Node.js 服务器（upstream-server.js，端口 9301），提供 WebSocket 回显、DoH（RFC 8484 POST/GET）、gRPC 三种形态端点。
- **测试方式**：先测"直连上游"基线，再测"经 Worker 反代"，逐项对照；关键场景做隔离与序列复现实验。
- **复现命令**：
  ```bash
  node upstream-server.js &                                  # 上游
  npx wrangler@3 dev worker.mjs --ip 127.0.0.1 --port 8787   # 代理
  node test-ws.js 8787 && node test-doh.js 8787 && node test-grpc.js 8787
  node ws-longevity.js 8787
  ```

## 二、结果矩阵

| 协议/场景 | 直连基线 | 经反代 | 结论 |
|---|---|---|---|
| WebSocket 握手 + 双向回显 | PASS (6ms) | **PASS** (79ms) | 完全可用 |
| WebSocket 存活 > 30s 超时窗口 | — | **PASS** (33s 后仍收发正常) | 超时只杀握手，不杀长连接，符合预期 |
| DoH POST (application/dns-message) | PASS | **PASS** | 完全可用 |
| DoH GET (?dns=base64url) | PASS | **PASS** | 完全可用 |
| gRPC 单次调用（grpc-status 在 END-TRAILERS） | PASS | **FAIL** | grpc-status 被运行时丢弃，调用无法确认 |
| gRPC trailers-only（grpc-status 在响应头） | PASS | **PASS**（干净连接） | 可用，但受下述连带缺陷影响 |
| gRPC Web（grpc-status 编码在正文尾帧） | PASS | **PASS** | 完全可用 |
| trailers 响应后紧邻的下一个请求 | — | **502（100% 复现）** | 新发现的连带缺陷，见下 |

## 三、关键发现

### 1. WebSocket：完全可用（含长连接）

- `Sec-WebSocket-Key`/`Accept` 端到端校验通过，证明 Worker 逐字转发握手头、101 直通的路径正确。
- 连接静默 33 秒后仍能正常收发，证明 `upstreamTimeoutMs`（finally 中的 clearTimeout）只约束 TTFB/握手，不会杀死已建立的 WS 长连接——**对 SSE/长轮询同样是好消息**。

### 2. DoH：完全可用

POST 与 GET 两种形式（RFC 8484 规定的两种合法形式）均通过，二进制报文、Content-Type、事务 ID、查询串全部端到端正确。若反代 `1.1.1.1/dns-query` 类服务，功能无损。

### 3. 原生 gRPC：不可用 —— 架构级限制，不是代码缺陷

两层原因，均出在 Workers 运行时而非这份代码：

- **grpc-status 丢失**：workerd 的 `Response` API 不支持 HTTP trailers。上游把 grpc-status 放在 END-TRAILERS（标准单次调用的唯一方式）时，客户端收不到状态码，gRPC 客户端无法确认调用结果（实测 200 + 正确正文 + 状态码凭空消失）。
- **连接池污染（新发现）**：上游返回"带 HTTP/1.1 chunked trailers 的响应"后，**紧邻的下一个请求（复用同一条 keep-alive 连接）稳定 502**（workerd internal error），再下一个请求恢复。序列复现 100%。即：trailers 响应不仅自身失效，还会连累相邻请求。生产环境若上游是 h2-only 的真 gRPC 服务器，workerd 出站 fetch（HTTP/1.1）根本无法与之握手，同样归于失败。

### 4. 仍可用的 gRPC 变体

- **trailers-only 响应**（grpc-status 放响应头）：干净连接下经代理完全可用。
- **gRPC-Web**（grpc-status 编码进正文尾帧）：完全可用，正文透传无损。

**落地结论**：浏览器场景用 gRPC-Web 可正常反代；服务端原生 gRPC（application/grpc over HTTP/2）在本架构下无法支持，任何代码修改都救不了，这是 Workers fetch 的运行时能力边界。

## 四、对既有结论的影响

- 之前判定"全协议反代"时未覆盖 gRPC：现修正为 **HTTP/HTTPS/SSE/WebSocket/DoH 全部可用；原生 gRPC 不可用（运行时限制）**。
- WebSocket 超时语义（"仅覆盖 TTFB"）的判断获实测确认，且对长连接是正确行为，无需修改。
- 新增风险项：若上游任何响应携带 HTTP trailers（罕见但真实存在，如某些 gRPC 网关/遥测注入方案），会触发相邻请求偶发 502。缓解方式：无（workerd 内部行为）；规避方式：确保上游不返回 trailers，或对该类路径回 502 快速失败。

## 五、文件清单

| 文件 | 用途 |
|---|---|
| worker.mjs | 被验证的 Worker（本地适配版） |
| upstream-server.js | 测试上游（WS/DoH/gRPC/gRPC-Web 端点，零依赖） |
| test-ws.js / test-doh.js / test-grpc.js | 三协议测试客户端 |
| ws-longevity.js | WS 长连接存活测试 |

## 九、完整验证矩阵：默认规则 + 自定义组合（2026-11-11）

按提交标准完成的完整验证，全部通过，未发现需修复的错误。唯一疑点（本地测试时 Location 未带 :8787）经两个独立探针定位为正确行为：`request.url` 由 Host 头构造，客户端 Host 不带端口时改写结果即为无端口形式——正是生产环境（https 443 入口）的预期输出。

### A. 默认规则（仅配 PROXY_ALLOWED_HOSTS + PROXY_UPSTREAM_HOSTS）

- **A1 https 默认 443**：健康检查确认默认配置为 `protocol=https:`、`port` 为空；443 端口 TCP 探针捕获到 Worker 发出的 TLS ClientHello（首字节 0x16 0x03，230 字节）——证明默认规则正确生成 `https://host:443` 的上游目标。本用例返回 502 属预期（探针不完成握手，仅为取证）。
- **A2 http 默认 80**：`protocol=http` + 端口留空，真实上游监听 80，经代理 GET 返回 200 且内容与直连基线逐字节一致；诊断头显示无端口（默认 80）。

### B. 自定义端口与协议组合（随机端口 11443 / 12581 / 12582）

- **B1 三随机端口 + http**：`app.test → 11443`、`nas.test → 12581`、通配 `→ 12582`，路由全部正确；自定义端口上内容透传 200、WebSocket 回显 PASS（11ms）、DoH POST/GET PASS、UUID 路径 + token 查询串到达上游；上游自引用绝对 Location（`http://127.0.0.1:11443/login`）经代理正确改写为对外域名（`http://app.test/login`），相对 Location 同样正确改写。
- **B2 混合 默认 80 + 自定义 12582**：`web.test`（端口留空）→ 默认 80 端到端 200；`files.test → 12582` 端到端 200。
- **兼容项**：旧版单端口变量 `PROXY_UPSTREAM_PORT` 回落正常。非白名单 Host 返回 421 正常。

复现环境：`proxy-verify/`（新增 `tls-probe-443.js` 探针；`upstream-server.js` 端口可用 `UPSTREAM_PORT` 指定，新增 `/__redirect` 自引用重定向端点）。

## 十、断言级加固：头转发真 bug 修复 + 四类新测试（2026-11-11）

### 发现的严重 bug（此前所有验证均未覆盖）

`buildUpstreamRequest` 中构造转发请求写为 `new Request(url, request, { headers, redirect })`——**Request 构造器只接受 (input, init) 两个参数，第三个参数被静默忽略**。后果：伪造头清除、X-Forwarded-* 重建、Origin/Referer 改写全部不生效，伪造的 `X-Forwarded-For` / `X-Forwarded-Host` / `Forwarded` / `X-Real-IP` 原样直达上游（经 echo 端点实测确认）。之前的验证全部通过是因为此前只测了响应侧行为（Cookie/Location/Alt-Svc）和协议透传，从未断言"上游实际收到的头集合"。

**修复**：改为显式 init 形式 `new Request(url, { method, headers, body: request.body, redirect: "manual" })`。

### 新增测试与结果（wrangler 4 / workerd）

| 测试 | 断言数 | 结果 |
|---|---|---|
| test-headers.js 伪造头断言（/__echo_headers 回显上游收到的头） | 9 | 修复前 6 FAIL → 修复后全 PASS |
| test-cookies.js 多 Set-Cookie（3 条，含 Expires 逗号陷阱） | 4 | PASS（逐条透传不合并，strip 模式 Domain 移除正确） |
| test-timeout.js TTFB 超时（/__slow?ms=5000 vs PROXY_TIMEOUT_MS=1500） | 3 | PASS（超时返回 504 + X-Proxy-Error: upstream-timeout；窗口内请求 200） |
| test-sse.js SSE 流式（/__sse，每秒 1 条共 5 条） | 3 | PASS（Content-Type 正确，事件间隔约 1000ms 逐条到达，无缓冲无中断） |
| 配置告警（六类坏配置：非法布尔/协议/端口/列表错位/白名单外路由/非法 cookie 模式） | 6 | 全部触发结构化 config_warning；同一项多次请求只告警一次（去重验证通过） |

### 回归

WS / DoH(POST+GET) / gRPC-Web / trailers-only / Alt-Svc 删除 / 421 白名单 / Location 改写：全部 PASS，与修复前一致；原生 gRPC 仍不可用（运行时限制，预期）。

### 同步修复

- 日志脱敏：两处错误日志的 URL 只保留 origin + 路径，查询串（可能携带 token）不再写入日志。
- README 工具链更正：wrangler@3 → wrangler@4（生产部署实际使用 4.160.0）。

复现环境新增：上游端点 /__echo_headers、/__setcookie_multi、/__slow、/__sse；测试 test-headers.js、test-cookies.js、test-timeout.js、test-sse.js。
