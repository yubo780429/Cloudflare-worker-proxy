/**
 * 配置层单元测试：默认值、并行变量对齐、非法值回落、告警文本与去重。
 * 运行：node --test tests/config.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";

import { CONFIG_DEFAULTS } from "../src/config/defaults.js";
import { loadConfig } from "../src/config/load-config.js";
import {
  parseBool,
  parseList,
  parsePositiveInt,
  normalizeProtocol,
  normalizePort,
  parseCookieDomainMode,
  parseParallel,
  validateUpstreamLists,
} from "../src/config/validate-config.js";

function captureConsole(method, fn) {
  const original = console[method];
  const lines = [];
  console[method] = (...args) => lines.push(args.join(" "));
  try {
    return { value: fn(), lines };
  } finally {
    console[method] = original;
  }
}

function parseWarn(line) {
  try { return JSON.parse(line); } catch { return null; }
}

test("loadConfig({}) 回落到完整默认配置", () => {
  const c = loadConfig({});
  assert.deepEqual(c.allowedHosts, ["example.com"]);
  assert.deepEqual(c.upstreams, CONFIG_DEFAULTS.upstreams);
  assert.deepEqual(c.upstreamHosts, ["upstream.example.com"]);
  assert.equal(c.rewriteLocation, true);
  assert.equal(c.rewriteCookies, true);
  assert.equal(c.cookieDomainMode, "strip");
  assert.equal(c.rewriteRequestOrigin, true);
  assert.equal(c.addDiagnosticHeaders, false);
  assert.equal(c.upstreamTimeoutMs, 30000);
  assert.equal(c.enableHealthCheck, true);
});

test("三组并行变量按索引一一对应，含非标端口与 http 协议", () => {
  const c = loadConfig({
    PROXY_ALLOWED_HOSTS: "app.example.com,nas.example.com",
    PROXY_UPSTREAM_HOSTS: "10.0.0.2,10.0.0.2",
    PROXY_UPSTREAM_PORTS: "9090,20252",
    PROXY_PUBLIC_HOSTS: "app.example.com,nas.example.com",
    PROXY_UPSTREAM_PROTOCOL: "HTTP",
  });
  assert.deepEqual(c.upstreams, [
    { host: "10.0.0.2", port: "9090", protocol: "http:", publicHost: "app.example.com" },
    { host: "10.0.0.2", port: "20252", protocol: "http:", publicHost: "nas.example.com" },
  ]);
  assert.deepEqual(c.upstreamHosts, ["10.0.0.2", "10.0.0.2"]);
  assert.deepEqual(c.allowedHosts, ["app.example.com", "nas.example.com"]);
});

test("端口留空项回落协议默认端口，PUBLIC_HOSTS 留空项回落通配", () => {
  const c = loadConfig({
    PROXY_UPSTREAM_HOSTS: "a.example.com,b.example.com",
    PROXY_UPSTREAM_PORTS: "9090,",
    PROXY_PUBLIC_HOSTS: "app.example.com,",
  });
  assert.equal(c.upstreams[0].port, "9090");
  assert.equal(c.upstreams[1].port, "");
  assert.equal(c.upstreams[0].publicHost, "app.example.com");
  assert.equal(c.upstreams[1].publicHost, "");
  assert.equal(c.upstreams[0].protocol, "https:");
});

test("旧版单端口变量 PROXY_UPSTREAM_PORT 对所有上游生效", () => {
  const c = loadConfig({
    PROXY_UPSTREAM_HOSTS: "a.example.com,b.example.com",
    PROXY_UPSTREAM_PORT: "9301",
  });
  assert.deepEqual(c.upstreams.map((u) => u.port), ["9301", "9301"]);
});

test("PROXY_UPSTREAM_PORTS 优先于旧版单端口变量", () => {
  const c = loadConfig({
    PROXY_UPSTREAM_HOSTS: "a.example.com,b.example.com",
    PROXY_UPSTREAM_PORTS: "9090,20252",
    PROXY_UPSTREAM_PORT: "9301",
  });
  assert.deepEqual(c.upstreams.map((u) => u.port), ["9090", "20252"]);
});

test("布尔开关只接受 true/false，大小写不敏感", () => {
  const c = loadConfig({
    PROXY_REWRITE_LOCATION: "FALSE",
    PROXY_REWRITE_COOKIES: "false",
    PROXY_REWRITE_ORIGIN: "FaLsE",
    PROXY_DIAGNOSTIC_HEADERS: "TRUE",
    PROXY_HEALTH_CHECK: "false",
  });
  assert.equal(c.rewriteLocation, false);
  assert.equal(c.rewriteCookies, false);
  assert.equal(c.rewriteRequestOrigin, false);
  assert.equal(c.addDiagnosticHeaders, true);
  assert.equal(c.enableHealthCheck, false);
});

test("parseBool 非法值告警并回落默认值", () => {
  const { value, lines } = captureConsole("warn", () =>
    parseBool("yes", true, "PROXY_REWRITE_LOCATION", (field, v, reason) =>
      console.warn(JSON.stringify({ event: "config_warning", field, value: String(v), reason }))));
  assert.equal(value, true);
  const log = parseWarn(lines[0]);
  assert.equal(log.field, "PROXY_REWRITE_LOCATION");
  assert.equal(log.value, "yes");
  assert.match(log.reason, /只接受 true\/false/);
});

test("normalizeProtocol 接受四种写法，非法值告警并回落", () => {
  const warn = () => {};
  assert.equal(normalizeProtocol("http", "https:", warn), "http:");
  assert.equal(normalizeProtocol("HTTPS", "https:", warn), "https:");
  assert.equal(normalizeProtocol("http:", "https:", warn), "http:");
  assert.equal(normalizeProtocol("", "https:", warn), "https:");

  const { value, lines } = captureConsole("warn", () =>
    normalizeProtocol("ftp", "https:", (field, v, reason) =>
      console.warn(JSON.stringify({ event: "config_warning", field, value: String(v), reason }))));
  assert.equal(value, "https:");
  assert.equal(parseWarn(lines[0]).field, "PROXY_UPSTREAM_PROTOCOL");
});

test("normalizePort 覆盖空值、边界、非法值，告警文本不变", () => {
  const warn = () => {};
  assert.equal(normalizePort("", warn), "");
  assert.equal(normalizePort(undefined, warn), "");
  assert.equal(normalizePort("1", warn), "1");
  assert.equal(normalizePort("65535", warn), "65535");

  const collect = (v) => captureConsole("warn", () =>
    normalizePort(v, (field, x, reason) =>
      console.warn(JSON.stringify({ event: "config_warning", field, value: String(x), reason }))));
  for (const bad of ["0", "65536", "-1", "80.5", "abc"]) {
    const r = collect(bad);
    assert.equal(r.value, "", `非法端口 ${bad} 应回落空串`);
    assert.equal(parseWarn(r.lines[0]).field, "PROXY_UPSTREAM_PORTS");
    assert.match(parseWarn(r.lines[0]).reason, /端口必须是 1-65535 的整数/);
  }
});

test("parseList / parseParallel / parsePositiveInt 的边界语义", () => {
  assert.deepEqual(parseList(" A.EXAMPLE.COM , b.example.com ,, ", ["fallback"]), ["a.example.com", "b.example.com"]);
  assert.deepEqual(parseList("", ["fallback"]), ["fallback"]);
  assert.deepEqual(parseParallel("9090,,20252"), ["9090", "", "20252"]);
  assert.deepEqual(parseParallel(undefined), []);
  assert.equal(parsePositiveInt("1500", 30000), 1500);
  assert.equal(parsePositiveInt("0", 30000), 30000);
  assert.equal(parsePositiveInt("abc", 30000), 30000);
  assert.equal(parsePositiveInt("-5", 30000), 30000);
});

test("parseCookieDomainMode 三种取值与非法回落", () => {
  const warn = () => {};
  assert.equal(parseCookieDomainMode("strip", warn), "strip");
  assert.equal(parseCookieDomainMode("", warn), "strip");
  assert.equal(parseCookieDomainMode("rewrite", warn), "rewrite");
  const { value, lines } = captureConsole("warn", () =>
    parseCookieDomainMode("bogus", (field, v, reason) =>
      console.warn(JSON.stringify({ event: "config_warning", field, value: String(v), reason }))));
  assert.equal(value, "strip");
  assert.equal(parseWarn(lines[0]).field, "PROXY_COOKIE_DOMAIN_MODE");
});

test("validateUpstreamLists 对长度错位与白名单外路由发出结构化告警", () => {
  const { lines } = captureConsole("warn", () =>
    validateUpstreamLists({
      hosts: ["a.example.com", "b.example.com"],
      ports: ["9090"],
      publicHosts: ["app.example.com", "nas.example.com", "extra.example.com"],
      allowedHosts: ["app.example.com"],
      warn: (field, value, reason) =>
        console.warn(JSON.stringify({ event: "config_warning", field, value: String(value), reason })),
    }));
  const logs = lines.map(parseWarn);
  assert.equal(logs.length, 4);
  assert.equal(logs[0].field, "PROXY_UPSTREAM_PORTS");
  assert.match(logs[0].reason, /数量不一致/);
  assert.equal(logs[1].field, "PROXY_PUBLIC_HOSTS");
  assert.match(logs[1].reason, /数量不一致/);
  assert.equal(logs[2].value, "nas.example.com");
  assert.match(logs[2].reason, /永远不可达/);
  assert.equal(logs[3].value, "extra.example.com");
});

test("loadConfig 的同一 field+value 告警只输出一次（isolate 级去重）", () => {
  const env = {
    PROXY_UPSTREAM_HOSTS: "dedup.example.com",
    PROXY_UPSTREAM_PORTS: "99999",
  };
  const { lines } = captureConsole("warn", () => {
    loadConfig(env);
    loadConfig(env);
    loadConfig(env);
  });
  const portWarnings = lines.map(parseWarn).filter((l) => l && l.field === "PROXY_UPSTREAM_PORTS");
  assert.equal(portWarnings.length, 1);
});
