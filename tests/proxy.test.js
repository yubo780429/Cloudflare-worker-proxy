/**
 * 代理层与 HTTP 出口单元测试：头策略、请求/响应构造、TTFB 超时、
 * 错误与健康检查响应。
 *
 * 运行：node --test tests/proxy.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createForwardHeaders } from "../src/headers/request-headers.js";
import {
  copyResponseHeaders,
  sanitizeResponseHeaders,
  applyResponseHeaderPolicy,
  HOP_BY_HOP_RESPONSE_HEADERS,
} from "../src/headers/response-headers.js";
import { buildUpstreamRequest } from "../src/proxy/build-request.js";
import { buildClientResponse } from "../src/proxy/build-response.js";
import { fetchUpstream } from "../src/proxy/fetch-upstream.js";
import { createErrorResponse, redactUrl } from "../src/http/errors.js";
import { createHealthResponse } from "../src/http/health.js";
import worker from "../worker.js";

const incomingUrl = new URL("https://app.example.com/api?q=1");
const upstreamUrl = new URL("http://10.0.0.2:9090/api?q=1");
const publicHost = "app.example.com";
const upstream = { host: "10.0.0.2", port: "9090", protocol: "http:" };
const config = {
  upstreamHosts: ["10.0.0.2"],
  rewriteLocation: true,
  rewriteCookies: true,
  cookieDomainMode: "strip",
  rewriteRequestOrigin: true,
  addDiagnosticHeaders: false,
};

test("请求头：伪造转发头被清除，可信头被重建", () => {
  const request = {
    headers: new Headers({
      "Host": "app.example.com",
      "X-Forwarded-For": "6.6.6.6",
      "X-Forwarded-Host": "evil.example.com",
      "Forwarded": "for=9.9.9.9",
      "X-Real-IP": "6.6.6.6",
      "X-Original-Host": "evil.example.com",
      "X-Forwarded-Server": "evil.example.com",
      "Authorization": "Bearer t",
      "Cookie": "s=1",
    }),
  };
  const h = createForwardHeaders({ request, incomingUrl, publicHost });
  assert.equal(h.get("host"), null);
  assert.equal(h.get("forwarded"), null);
  assert.equal(h.get("x-real-ip"), null);
  assert.equal(h.get("x-original-host"), null);
  assert.equal(h.get("x-forwarded-server"), null);
  assert.equal(h.get("x-forwarded-for"), null, "无 cf-connecting-ip 时删除伪造 XFF");
  assert.equal(h.get("x-forwarded-host"), "app.example.com");
  assert.equal(h.get("x-forwarded-proto"), "https");
  assert.equal(h.get("authorization"), "Bearer t");
  assert.equal(h.get("cookie"), "s=1");
});

test("请求头：cf-connecting-ip 存在时写入可信 XFF", () => {
  const request = {
    headers: new Headers({
      "CF-Connecting-IP": "203.0.113.7",
      "X-Forwarded-For": "6.6.6.6",
    }),
  };
  const h = createForwardHeaders({ request, incomingUrl, publicHost });
  assert.equal(h.get("x-forwarded-for"), "203.0.113.7");
});

test("响应头：copyResponseHeaders 跳过 Set-Cookie", () => {
  const source = new Headers({ "Content-Type": "text/plain", "X-Keep": "yes" });
  source.append("Set-Cookie", "a=1");
  source.append("Set-Cookie", "b=2");
  const out = copyResponseHeaders(source);
  assert.equal(out.get("content-type"), "text/plain");
  assert.equal(out.get("x-keep"), "yes");
  assert.equal(out.get("set-cookie"), null);
});

test("响应头：Alt-Svc / hop-by-hop / Content-Length / Vercel 头一律删除，Content-Range 保留", () => {
  const h = new Headers({
    "Alt-Svc": 'h3="upstream.example.com:443"',
    "Connection": "keep-alive",
    "Transfer-Encoding": "chunked",
    "Upgrade": "h2c",
    "TE": "trailers",
    "Keep-Alive": "timeout=5",
    "Trailer": "X-Y",
    "Proxy-Authenticate": "Basic",
    "Proxy-Authorization": "Basic x",
    "Content-Length": "999",
    "Content-Range": "bytes 0-9/100",
    "X-Vercel-Id": "x",
    "X-Vercel-Cache": "MISS",
  });
  sanitizeResponseHeaders(h);
  assert.equal(h.get("alt-svc"), null, "Alt-Svc 必须删除（必修项）");
  for (const name of HOP_BY_HOP_RESPONSE_HEADERS) {
    assert.equal(h.get(name), null, `逐跳头 ${name} 不应透传`);
  }
  assert.equal(h.get("content-length"), null);
  assert.equal(h.get("x-vercel-id"), null);
  assert.equal(h.get("x-vercel-cache"), null);
  assert.equal(h.get("content-range"), "bytes 0-9/100", "206 断点续传头应保留");
});

test("响应头：诊断头默认关闭，开启后带上游主机与端口；>=400 强制 no-store", () => {
  const off = new Headers();
  applyResponseHeaderPolicy({ headers: off, upstream, config, status: 200 });
  assert.equal(off.get("x-reverse-proxy"), null);
  assert.equal(off.get("cache-control"), null);

  const on = new Headers();
  applyResponseHeaderPolicy({
    headers: on, upstream, config: { ...config, addDiagnosticHeaders: true }, status: 200,
  });
  assert.equal(on.get("x-reverse-proxy"), "cloudflare-worker");
  assert.equal(on.get("x-reverse-proxy-upstream"), "10.0.0.2:9090");

  const err = new Headers({ "Cache-Control": "public, max-age=600" });
  applyResponseHeaderPolicy({ headers: err, upstream, config, status: 502 });
  assert.equal(err.get("cache-control"), "no-store");
});

test("buildUpstreamRequest：两参构造保留 method / 头改写 / redirect=manual", () => {
  const request = new Request("https://app.example.com/api?q=1", {
    method: "GET",
    headers: {
      "X-Forwarded-For": "6.6.6.6",
      "Origin": "https://app.example.com",
      "Authorization": "Bearer t",
    },
  });
  const out = buildUpstreamRequest({
    request, incomingUrl, upstreamUrl, publicHost, upstream, config,
  });
  assert.equal(out.method, "GET");
  assert.equal(out.url, "http://10.0.0.2:9090/api?q=1");
  assert.equal(out.redirect, "manual");
  assert.equal(out.headers.get("x-forwarded-for"), null);
  assert.equal(out.headers.get("x-forwarded-host"), "app.example.com");
  assert.equal(out.headers.get("origin"), "http://10.0.0.2:9090/");
  assert.equal(out.headers.get("authorization"), "Bearer t");
  assert.equal(out.body, null, "GET 请求体保持 null，不缓冲重建");
});

test("buildClientResponse：保留状态码、三条 Cookie、头清理，正文按流传递", async () => {
  const upstreamHeaders = new Headers({ "Content-Type": "text/plain", "Alt-Svc": "h3=\":443\"" });
  upstreamHeaders.append("Set-Cookie", "a=1; Domain=upstream.example.com; Path=/");
  upstreamHeaders.append("Set-Cookie", "b=2; Expires=Wed, 11 Nov 2027 00:00:00 GMT");
  upstreamHeaders.append("Set-Cookie", "c=3; SameSite=Lax");
  const upstreamResponse = new Response("stream-body", {
    status: 200,
    statusText: "OK",
    headers: upstreamHeaders,
  });

  const out = buildClientResponse({
    upstreamResponse, incomingUrl, publicHost, upstream, config,
  });
  assert.equal(out.status, 200);
  assert.equal(out.statusText, "OK");
  assert.equal(out.headers.get("alt-svc"), null);
  assert.equal(out.headers.get("content-length"), null);
  assert.equal(out.headers.getSetCookie().length, 3, "多条 Set-Cookie 不得合并");
  assert.equal(out.headers.getSetCookie()[0], "a=1; Path=/");
  assert.equal(await out.text(), "stream-body", "正文内容未被读取或重建");
});

test("fetchUpstream：成功返回原 Response 且未超时", async () => {
  const original = globalThis.fetch;
  const expected = new Response("ok");
  globalThis.fetch = async () => expected;
  try {
    const r = await fetchUpstream({ upstreamRequest: new Request("http://x/"), upstreamUrl, timeoutMs: 1000 });
    assert.equal(r.timedOut, false);
    assert.strictEqual(r.response, expected);
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchUpstream：TTFB 超时返回 timedOut，日志 URL 已脱敏", async () => {
  const original = globalThis.fetch;
  const originalError = console.error;
  const lines = [];
  globalThis.fetch = (_req, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      reject(e);
    });
  });
  console.error = (...a) => lines.push(a.join(" "));
  try {
    const r = await fetchUpstream({
      upstreamRequest: new Request("http://x/"),
      upstreamUrl: new URL("http://10.0.0.2:9090/dns-query?dns=SECRET"),
      timeoutMs: 20,
    });
    assert.equal(r.timedOut, true);
    assert.equal(r.response, null);
    const log = JSON.parse(lines[0]);
    assert.equal(log.event, "upstream_timeout");
    assert.equal(log.upstreamUrl, "http://10.0.0.2:9090/dns-query", "查询串不得进日志");
    assert.equal(log.timeoutMs, 20);
  } finally {
    globalThis.fetch = original;
    console.error = originalError;
  }
});

test("fetchUpstream：非 AbortError 向上抛出，交由入口统一转 502", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("connect failed"); };
  try {
    await assert.rejects(
      () => fetchUpstream({ upstreamRequest: new Request("http://x/"), upstreamUrl, timeoutMs: 1000 }),
      /connect failed/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("createErrorResponse：状态码、正文与四个响应头固定", async () => {
  const r = createErrorResponse(421, "Misdirected Request", "host-not-allowed");
  assert.equal(r.status, 421);
  assert.equal(await r.text(), "Misdirected Request");
  assert.equal(r.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("x-proxy-error"), "host-not-allowed");
  assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow");
});

test("createHealthResponse：默认不泄露上游，诊断模式才附带", async () => {
  const c = { ...config, upstreams: [upstream], addDiagnosticHeaders: false };
  const plain = await createHealthResponse({ publicHost, config: c }).json();
  assert.equal(plain.status, "ok");
  assert.equal(plain.service, "cloudflare-worker-reverse-proxy");
  assert.equal(plain.publicHost, publicHost);
  assert.equal("upstreams" in plain, false);

  const diag = await createHealthResponse({
    publicHost, config: { ...c, addDiagnosticHeaders: true },
  }).json();
  assert.deepEqual(diag.upstreams, [upstream]);
});

test("redactUrl：剔除查询串与哈希，无效 URL 返回占位符", () => {
  assert.equal(redactUrl("https://a.example.com/p?token=SECRET#frag"), "https://a.example.com/p");
  assert.equal(redactUrl("not-a-url"), "<unparseable-url>");
});

test("入口白名单先于健康检查：非白名单 Host 的 /__proxy_health 仍返回 421", async () => {
  const res = await worker.fetch(
    new Request("https://evil.example.com/__proxy_health"),
    { PROXY_ALLOWED_HOSTS: "app.example.com" },
    {},
  );
  assert.equal(res.status, 421);
  assert.equal(res.headers.get("x-proxy-error"), "host-not-allowed");
});

test("入口顶层异常兜底：选路失败统一转 502 + upstream-request-failed", async () => {
  const originalWarn = console.warn;
  const originalError = console.error;
  const errorLines = [];
  console.warn = () => {};
  console.error = (...a) => errorLines.push(a.join(" "));
  try {
    const res = await worker.fetch(
      new Request("https://app.example.com/x?token=SECRET"),
      {
        PROXY_ALLOWED_HOSTS: "app.example.com",
        PROXY_UPSTREAM_HOSTS: "10.0.0.2",
        PROXY_PUBLIC_HOSTS: "other.example.com",
      },
      {},
    );
    assert.equal(res.status, 502);
    assert.equal(res.headers.get("x-proxy-error"), "upstream-request-failed");
    const log = JSON.parse(errorLines[0]);
    assert.equal(log.event, "proxy_unhandled_error");
    assert.equal(log.url, "https://app.example.com/x", "错误日志中的查询串必须脱敏");
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
});
