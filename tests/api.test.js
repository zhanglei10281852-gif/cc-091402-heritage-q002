import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { createTestService, clockAt, ACTORS } from "./helpers.js";

async function startServer(service) {
  const server = createApp(service);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((resolve) => server.close(resolve));
  return { base, close };
}

async function setupFlow(service) {
  await service.registerArtifact({ id: "artifact-0001", name: "受潮古籍", measurements: { pH: 5.4 }, actor: ACTORS.admin });
  await service.createWorkOrder({ id: "order-1", artifactId: "artifact-0001", title: "受潮古籍修复", actor: ACTORS.restorer });
  await service.draftPlan("order-1", {
    content: { adhesive: "小麦淀粉浆", drying: "阴干 72 小时" },
    phases: [
      { id: "clean", name: "表面去污除霉" },
      { id: "dry", name: "干燥定型", dependsOn: ["clean"] },
    ],
    requiredExperts: 1,
    actor: ACTORS.restorer,
  });
  await service.countersignPlan("order-1", 1, { actor: ACTORS.expert1 });
  await service.registerMaterialLot({
    id: "lot-1",
    name: "小麦淀粉浆",
    supplier: "西泠文保材料公司",
    sourceEvidence: "COA-2026-10",
    quantity: 4,
    expiryDate: "2026-12-31",
    actor: ACTORS.admin,
  });
}

test("HTTP 全流程：登记、会签、领料、施工、质控", async (context) => {
  const { service } = await createTestService();
  const { base, close } = await startServer(service);
  context.after(close);
  await setupFlow(service);

  // HTTP 头只能用 ASCII 角色代码（admin/restorer/expert/qc/visitor）
  const roleCode = { 管理员: "admin", 保护人员: "restorer", 专家: "expert", 质控: "qc" };
  const actor = (who) => ({
    "x-actor-id": who.id,
    "x-actor-role": roleCode[who.role] ?? who.role,
    "content-type": "application/json",
  });

  // 领料 3 份成功
  let res = await fetch(`${base}/material-claims`, {
    method: "POST",
    headers: actor(ACTORS.restorer),
    body: JSON.stringify({ orderId: "order-1", operationId: "op_order-1_v1_clean", lotId: "lot-1", quantity: 3 }),
  });
  assert.equal(res.status, 201);
  const claim = await res.json();
  assert.equal(claim.quantity, 3);

  // 再领 2 份超过库存 -> 409
  res = await fetch(`${base}/material-claims`, {
    method: "POST",
    headers: actor(ACTORS.restorer2),
    body: JSON.stringify({ orderId: "order-1", operationId: "op_order-1_v1_clean", lotId: "lot-1", quantity: 2 }),
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "insufficient_stock");

  // 开工 -> 完工 -> 验收通过
  for (const step of ["start", "complete"]) {
    res = await fetch(`${base}/operations/op_order-1_v1_clean/${step}`, { method: "POST", headers: actor(ACTORS.restorer) });
    assert.equal(res.status, 200, await res.text());
  }
  res = await fetch(`${base}/operations/op_order-1_v1_clean/inspect`, {
    method: "POST",
    headers: actor({ id: "qc-1", role: "质控" }),
    body: JSON.stringify({ passed: true, sample: { id: "s1", expected: { pH: 6.5 }, actual: { pH: 6.6 } } }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "accepted");

  // 依赖工序现在可开工
  res = await fetch(`${base}/operations/op_order-1_v1_dry/start`, { method: "POST", headers: actor(ACTORS.restorer) });
  assert.equal(res.status, 200);
});

test("过期材料经 HTTP 领用返回 409 material_expired", async (context) => {
  const clock = clockAt("2026-09-22T09:00:00+08:00");
  const { service } = await createTestService(clock);
  const { base, close } = await startServer(service);
  context.after(close);
  await setupFlow(service);
  await service.registerMaterialLot({
    id: "lot-old",
    name: "旧糨糊",
    supplier: "苏州颜料厂",
    sourceEvidence: "COA-2025-01",
    quantity: 9,
    expiryDate: "2026-09-01",
    actor: ACTORS.admin,
  });
  const res = await fetch(`${base}/material-claims`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-actor-id": "r1", "x-actor-role": "restorer" },
    body: JSON.stringify({ orderId: "order-1", operationId: "op_order-1_v1_clean", lotId: "lot-old", quantity: 1 }),
  });
  assert.equal(res.status, 409);
  const payload = await res.json();
  assert.equal(payload.error, "material_expired");
  assert.equal(payload.details.expiryDate, "2026-09-01");
});

test("时间线仅管理员可导出，非法 JSON 返回 400，未知路由 404", async (context) => {
  const { service } = await createTestService();
  const { base, close } = await startServer(service);
  context.after(close);
  await setupFlow(service);

  let res = await fetch(`${base}/artifacts/artifact-0001/timeline`, {
    headers: { "x-actor-id": "r1", "x-actor-role": "restorer" },
  });
  assert.equal(res.status, 403);

  res = await fetch(`${base}/artifacts/artifact-0001/timeline`, {
    headers: { "x-actor-id": "a1", "x-actor-role": "admin" },
  });
  assert.equal(res.status, 200);
  const timeline = await res.json();
  assert.equal(timeline.artifact.id, "artifact-0001");
  assert.ok(timeline.events.length >= 5);
  assert.ok(timeline.responsibilityChain.some((entry) => entry.actor.id === "expert-1"));

  res = await fetch(`${base}/artifacts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{不是合法json",
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid_json");

  res = await fetch(`${base}/no/such/path`);
  assert.equal(res.status, 404);
});
