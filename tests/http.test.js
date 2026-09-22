import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { createTestService } from "./helpers.js";

async function startServer(service) {
  const server = createApp({ service });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function api(port, method, route, body) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, body: json, headers: response.headers };
}

const PLAN_BODY = {
  workOrderId: "wo-http-1",
  actor: "restorer-wang",
  changeSummary: "初版方案",
  riskNote: { summary: "翘曲风险", mitigations: "慢速阴干" },
  phases: [{ code: "cleaning", name: "除尘" }],
  materials: [{ name: "浆糊", plannedQuantity: 1, unit: "g" }],
};

test("HTTP 完整流转：登记->工单->草拟->送审->会签->批准->待办", async () => {
  const harness = await createTestService();
  test.after(harness.cleanup);
  const server = await startServer(harness.service);
  test.after(server.close);
  const port = server.port;

  let res = await api(port, "POST", "/api/artifacts", {
    artifactId: "artifact-http-1",
    name: "古籍",
    actor: "curator-li",
  });
  assert.equal(res.status, 201);

  res = await api(port, "POST", "/api/work-orders", {
    workOrderId: "wo-http-1",
    artifactId: "artifact-http-1",
    title: "修复",
    actor: "curator-li",
  });
  assert.equal(res.status, 201);

  res = await api(port, "POST", "/api/plans", PLAN_BODY);
  assert.equal(res.status, 201);
  const planId = res.body.planId;

  // 路径参数必须被注入：送审不带 planId 也应成功
  res = await api(port, "POST", `/api/plans/${planId}/submit`, { actor: "restorer-wang" });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "submitted");

  res = await api(port, "POST", `/api/plans/${planId}/countersign`, {
    actor: "expert-zhao",
    decision: "approve",
  });
  assert.equal(res.status, 200);
  res = await api(port, "POST", `/api/plans/${planId}/countersign`, {
    actor: "expert-qian",
    decision: "approve",
  });
  assert.equal(res.status, 200);

  res = await api(port, "POST", `/api/plans/${planId}/decide`, { actor: "director-sun" });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "approved");
  assert.equal(res.body.spawned.length, 1);

  res = await api(port, "GET", "/api/todos?workOrderId=wo-http-1");
  assert.equal(res.status, 200);
  assert.equal(res.body[0].code, "cleaning");
});

test("健康检查保留，未知路由 404，领域错误返回结构化 JSON", async () => {
  const harness = await createTestService();
  test.after(harness.cleanup);
  const server = await startServer(harness.service);
  test.after(server.close);
  const port = server.port;

  const health = await api(port, "GET", "/health");
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { status: "ok", service: "heritage-service-starter" });

  const missing = await api(port, "GET", "/api/work-orders/missing");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, "not_found");

  const bad = await api(port, "POST", "/api/work-orders", { artifactId: "nope", title: "x", actor: "curator" });
  assert.equal(bad.status, 404);
});

test("HTTP 端到端：开工->过期材料拦截->时间线 CSV 导出", async () => {
  const harness = await createTestService();
  test.after(harness.cleanup);
  const { service } = harness;
  const server = await startServer(service);
  test.after(server.close);
  const port = server.port;

  await api(port, "POST", "/api/artifacts", {
    artifactId: "artifact-0001",
    name: "受潮古籍",
    actor: "curator-li",
  });
  await api(port, "POST", "/api/work-orders", {
    workOrderId: "wo1",
    artifactId: "artifact-0001",
    title: "修复",
    actor: "curator-li",
  });
  const draft = await api(port, "POST", "/api/plans", {
    workOrderId: "wo1",
    actor: "restorer-wang",
    changeSummary: "初版",
    riskNote: { summary: "风险", mitigations: "措施" },
    phases: [{ code: "cleaning", name: "除尘" }],
  });
  const planId = draft.body.planId;
  await api(port, "POST", `/api/plans/${planId}/submit`, { actor: "restorer-wang" });
  await api(port, "POST", `/api/plans/${planId}/countersign`, { actor: "e1", decision: "approve" });
  await api(port, "POST", `/api/plans/${planId}/countersign`, { actor: "e2", decision: "approve" });
  await api(port, "POST", `/api/plans/${planId}/decide`, { actor: "director" });

  const todos = await api(port, "GET", "/api/todos?workOrderId=wo1");
  const instanceId = todos.body[0].instanceId;
  let res = await api(port, "POST", `/api/phases/${instanceId}/start`, { actor: "restorer-wang" });
  assert.equal(res.status, 200);

  await api(port, "POST", "/api/material-batches", {
    batchId: "b1",
    name: "脱酸剂",
    quantity: 5,
    unit: "L",
    expiresAt: "2000-01-01T00:00:00Z",
    supplier: "文保材料厂",
    certificateNo: "C1",
    actor: "keeper",
  });
  res = await api(port, "POST", "/api/requisitions", {
    instanceId,
    batchId: "b1",
    quantity: 1,
    actor: "restorer-chen",
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error, "batch_expired");

  const csv = await fetch(`http://127.0.0.1:${port}/api/artifacts/artifact-0001/timeline.csv`);
  assert.equal(csv.status, 200);
  assert.equal(csv.headers.get("content-type"), "text/csv; charset=utf-8");
  const text = await csv.text();
  assert.ok(text.split("\r\n").length >= 6);
});
