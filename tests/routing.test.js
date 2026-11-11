/**
 * 路由层单元测试：精确匹配、通配池、随机选择、无可用上游。
 * 运行：node --test tests/routing.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";

import { selectUpstream } from "../src/routing/select-upstream.js";

const upstream = (host, publicHost = "", port = "") => ({ host, publicHost, port, protocol: "https:" });

test("空上游列表抛错（顶层入口会转成 502）", () => {
  assert.throws(() => selectUpstream([], "app.example.com"), /未配置任何上游域名/);
  assert.throws(() => selectUpstream(undefined, "app.example.com"), /未配置任何上游域名/);
});

test("单个通配上游恒返回同一配置块", () => {
  const only = upstream("a.example.com");
  for (let i = 0; i < 20; i++) {
    assert.strictEqual(selectUpstream([only], "any.example.com"), only);
  }
});

test("publicHost 精确匹配优先于通配池", () => {
  const list = [
    upstream("pool-a.example.com"),
    upstream("exact.example.com", "app.example.com"),
  ];
  assert.equal(selectUpstream(list, "app.example.com").host, "exact.example.com");
});

test("无精确匹配时回落到通配池", () => {
  const list = [
    upstream("pool-a.example.com"),
    upstream("exact.example.com", "other.example.com"),
  ];
  assert.equal(selectUpstream(list, "app.example.com").host, "pool-a.example.com");
});

test("所有块都有 publicHost 且都不匹配时抛错", () => {
  const list = [
    upstream("a.example.com", "a.example.com"),
    upstream("b.example.com", "b.example.com"),
  ];
  assert.throws(() => selectUpstream(list, "app.example.com"), /没有可服务 app\.example\.com 的上游配置块/);
});

test("精确匹配池内多节点按 Math.random 选择", () => {
  const list = [
    upstream("node-1.example.com", "app.example.com"),
    upstream("node-2.example.com", "app.example.com"),
    upstream("pool.example.com"),
  ];
  const original = Math.random;
  try {
    Math.random = () => 0;
    assert.equal(selectUpstream(list, "app.example.com").host, "node-1.example.com");
    Math.random = () => 0.999;
    assert.equal(selectUpstream(list, "app.example.com").host, "node-2.example.com");
  } finally {
    Math.random = original;
  }
});

test("通配池内多节点按 Math.random 选择", () => {
  const list = [upstream("w1.example.com"), upstream("w2.example.com")];
  const original = Math.random;
  try {
    Math.random = () => 0.999;
    assert.equal(selectUpstream(list, "any.example.com").host, "w2.example.com");
  } finally {
    Math.random = original;
  }
});

test("多端口不同路由各自命中，端口随配置块返回", () => {
  const list = [
    upstream("10.0.0.2", "app.example.com", "9090"),
    upstream("10.0.0.2", "nas.example.com", "20252"),
  ];
  assert.equal(selectUpstream(list, "app.example.com").port, "9090");
  assert.equal(selectUpstream(list, "nas.example.com").port, "20252");
});
