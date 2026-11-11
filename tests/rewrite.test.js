/**
 * 改写层单元测试：Location / Set-Cookie / Origin-Referer。
 *
 * 说明：本组断言锁定「拆分前既有行为」，包括已知但不在此次拆分
 * 范围内修正的两点——只比较 hostname 导致的跨端口误改写、相对
 * Location 被改写成绝对地址。它们作为回归基线，不是正确性背书。
 *
 * 运行：node --test tests/rewrite.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";

import { rewriteLocationHeader } from "../src/rewrite/location.js";
import {
  rewriteSetCookieHeaders,
  copySetCookieHeaders,
  getSetCookieValues,
} from "../src/rewrite/cookies.js";
import {
  rewriteRequestHeaderUrl,
  applyOriginRefererRewrite,
} from "../src/rewrite/origin-referer.js";

const incomingUrl = new URL("https://app.example.com/page");
const publicHost = "app.example.com";
const upstream = { host: "10.0.0.2", port: "9090", protocol: "http:" };
const config = { upstreamHosts: ["10.0.0.2"] };

function locationCase(location) {
  const headers = new Headers({ location });
  rewriteLocationHeader({ headers, incomingUrl, publicHost, upstream, config });
  return headers.get("location");
}

test("Location：指向上游主机的绝对跳转改写回对外域名", () => {
  assert.equal(
    locationCase("http://10.0.0.2:9090/login?next=%2Fhome"),
    "https://app.example.com/login?next=%2Fhome",
  );
});

test("Location：第三方跳转保持原样（OAuth / 支付）", () => {
  assert.equal(
    locationCase("https://third.example.com/oauth?state=1"),
    "https://third.example.com/oauth?state=1",
  );
});

test("Location：相对跳转按现有实现被改写为绝对地址", () => {
  assert.equal(locationCase("/login"), "https://app.example.com/login");
});

test("Location：同主机跨端口跳转当前也会被改写（回归基线）", () => {
  assert.equal(
    locationCase("http://10.0.0.2:20252/login"),
    "https://app.example.com/login",
  );
});

test("Location：无 Location 头时不报错", () => {
  const headers = new Headers();
  assert.doesNotThrow(() =>
    rewriteLocationHeader({ headers, incomingUrl, publicHost, upstream, config }));
  assert.equal(headers.get("location"), null);
});

test("Location：无效 URL 保留原值并输出结构化告警", () => {
  const headers = new Headers({ location: "http://[" });
  const original = console.warn;
  const lines = [];
  console.warn = (...a) => lines.push(a.join(" "));
  try {
    rewriteLocationHeader({ headers, incomingUrl, publicHost, upstream, config });
  } finally {
    console.warn = original;
  }
  assert.equal(headers.get("location"), "http://[");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).event, "location_header_parse_failed");
});

const COOKIES = [
  "session=abc123; Path=/; Domain=upstream.example.com; HttpOnly",
  "prefs=dark; Path=/; Expires=Wed, 11 Nov 2027 00:00:00 GMT",
  "tracker=x; Domain=.upstream.example.com; SameSite=Lax",
];

function sourceCookieHeaders() {
  const h = new Headers();
  for (const c of COOKIES) h.append("Set-Cookie", c);
  return h;
}

test("Set-Cookie：strip 模式逐条移除 Domain，保留 Expires 中的逗号", () => {
  const target = new Headers();
  rewriteSetCookieHeaders({
    targetHeaders: target,
    sourceHeaders: sourceCookieHeaders(),
    publicHost: "app.example.com",
    cookieDomainMode: "strip",
  });
  const got = target.getSetCookie();
  assert.equal(got.length, 3, "三条 Set-Cookie 必须逐条保留");
  assert.equal(got[0], "session=abc123; Path=/; HttpOnly");
  assert.equal(got[1], "prefs=dark; Path=/; Expires=Wed, 11 Nov 2027 00:00:00 GMT");
  assert.equal(got[2], "tracker=x; SameSite=Lax");
});

test("Set-Cookie：rewrite 模式把 Domain 改写为对外域名", () => {
  const target = new Headers();
  rewriteSetCookieHeaders({
    targetHeaders: target,
    sourceHeaders: sourceCookieHeaders(),
    publicHost: "app.example.com",
    cookieDomainMode: "rewrite",
  });
  const got = target.getSetCookie();
  assert.equal(got.length, 3);
  assert.match(got[0], /Domain=app\.example\.com/);
  assert.match(got[2], /Domain=app\.example\.com/);
  assert.ok(!got[1].includes("Domain="), "本来没有 Domain 的 Cookie 不应被补写");
});

test("Set-Cookie：关闭改写时原样逐条复制", () => {
  const target = new Headers();
  copySetCookieHeaders(target, sourceCookieHeaders());
  assert.deepEqual(target.getSetCookie(), COOKIES);
});

test("getSetCookieValues：getAll / getSetCookie / get 三条兼容路径", () => {
  assert.deepEqual(
    getSetCookieValues({ getAll: () => ["a=1", "b=2"] }),
    ["a=1", "b=2"],
    "Workers 运行时走 getAll 分支",
  );
  assert.deepEqual(
    getSetCookieValues(sourceCookieHeaders()),
    COOKIES,
    "Node 原生 Headers 走 getSetCookie 分支",
  );
  assert.deepEqual(getSetCookieValues({ get: () => "a=1" }), ["a=1"]);
  assert.deepEqual(getSetCookieValues({ get: () => null }), []);
});

test("Origin / Referer：仅公开域名被改写为上游地址", () => {
  const headers = new Headers({
    origin: "https://app.example.com",
    referer: "https://app.example.com/page?q=1",
  });
  applyOriginRefererRewrite({ headers, publicHost, upstream, enabled: true });
  assert.equal(headers.get("origin"), "http://10.0.0.2:9090/");
  assert.equal(headers.get("referer"), "http://10.0.0.2:9090/page?q=1");
});

test("Origin / Referer：第三方来源、null、无效值与关闭开关均保持原样", () => {
  const cases = [
    "https://third.example.com",
    "null",
    "not-a-url",
  ];
  for (const value of cases) {
    const headers = new Headers({ origin: value });
    applyOriginRefererRewrite({ headers, publicHost, upstream, enabled: true });
    assert.equal(headers.get("origin"), value, `值 ${value} 不应被改写`);
  }

  const off = new Headers({ origin: "https://app.example.com" });
  applyOriginRefererRewrite({ headers: off, publicHost, upstream, enabled: false });
  assert.equal(off.get("origin"), "https://app.example.com");
});

test("rewriteRequestHeaderUrl 单头调用保持端口与路径", () => {
  const headers = new Headers({ referer: "https://app.example.com/a/b?x=1" });
  rewriteRequestHeaderUrl(headers, "referer", publicHost, upstream);
  assert.equal(headers.get("referer"), "http://10.0.0.2:9090/a/b?x=1");
});
