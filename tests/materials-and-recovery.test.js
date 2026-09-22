import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../src/lib/errors.js";
import { EventStore } from "../src/lib/event-store.js";
import { RestorationService } from "../src/domain/service.js";
import { createTestService, clockAt, ACTORS } from "./helpers.js";

async function orderWithStartedOp(service) {
  await service.registerArtifact({ id: "artifact-0001", name: "受潮古籍", actor: ACTORS.admin });
  const order = await service.createWorkOrder({
    artifactId: "artifact-0001",
    title: "受潮古籍修复",
    actor: ACTORS.restorer,
  });
  await service.draftPlan(order.id, {
    content: { adhesive: "小麦淀粉浆", drying: "阴干 72 小时" },
    phases: [{ id: "backing", name: "补缀托裱" }],
    requiredExperts: 1,
    actor: ACTORS.restorer,
  });
  await service.countersignPlan(order.id, 1, { actor: ACTORS.expert1 });
  const op = `op_${order.id}_v1_backing`;
  await service.startOperation(op, { actor: ACTORS.restorer });
  return { order, op };
}

test("来源不明的材料禁止入库", async () => {
  const { service } = await createTestService();
  await assert.rejects(
    service.registerMaterialLot({
      name: "甲基纤维素",
      quantity: 10,
      expiryDate: "2026-12-31",
      actor: ACTORS.admin,
    }),
    (error) => error instanceof DomainError && error.code === "source_unknown",
  );
});

test("过期与已封存材料阻止领用", async () => {
  const clock = clockAt("2026-09-22T09:00:00+08:00");
  const { service } = await createTestService(clock);
  const { order, op } = await orderWithStartedOp(service);

  await service.registerMaterialLot({
    id: "lot-expired",
    name: "过期小麦淀粉",
    supplier: "苏州颜料厂",
    sourceEvidence: "COA-2025-01",
    quantity: 5,
    expiryDate: "2026-09-21",
    actor: ACTORS.admin,
  });
  await assert.rejects(
    service.claimMaterial({ orderId: order.id, operationId: op, lotId: "lot-expired", quantity: 1, actor: ACTORS.restorer }),
    (error) => error.code === "material_expired",
  );

  const goodLot = await service.registerMaterialLot({
    id: "lot-good",
    name: "甲基纤维素",
    supplier: "西泠文保材料公司",
    sourceEvidence: "COA-2026-09",
    quantity: 3,
    expiryDate: "2026-12-31",
    actor: ACTORS.admin,
  });
  await service.quarantineMaterialLot("lot-good", { reason: "抽检发现包装破损", actor: ACTORS.admin });
  await assert.rejects(
    service.claimMaterial({ orderId: order.id, operationId: op, lotId: "lot-good", quantity: 1, actor: ACTORS.restorer }),
    (error) => error.code === "material_quarantined",
  );
  assert.deepEqual((await service.getMaterialLot("lot-good")).quarantine, {
    reason: "抽检发现包装破损",
    by: "admin-1",
    at: goodLot.createdAt,
  });
});

test("多个修复师并发领取同一批材料：库存与用量保持一致", async () => {
  const { service } = await createTestService();
  const { order, op } = await orderWithStartedOp(service);
  await service.registerMaterialLot({
    id: "lot-1",
    name: "小麦淀粉浆",
    supplier: "西泠文保材料公司",
    sourceEvidence: "COA-2026-10",
    quantity: 10,
    expiryDate: "2026-12-31",
    actor: ACTORS.admin,
  });

  // 两个修复师各领 6 份，总量 12 > 10：恰好一个成功、一个被拒
  const results = await Promise.allSettled([
    service.claimMaterial({ orderId: order.id, operationId: op, lotId: "lot-1", quantity: 6, actor: ACTORS.restorer }),
    service.claimMaterial({ orderId: order.id, operationId: op, lotId: "lot-1", quantity: 6, actor: ACTORS.restorer2 }),
  ]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, "insufficient_stock");

  const lot = await service.getMaterialLot("lot-1");
  assert.equal(lot.reservedQuantity, 6);
  assert.equal(lot.availableQuantity, 4);

  const claimId = fulfilled[0].value.id;
  await service.recordUsage(claimId, { quantity: 5.5, actor: ACTORS.restorer });
  assert.equal((await service.getClaim(claimId)).usedQuantity, 5.5);
  await assert.rejects(
    service.recordUsage(claimId, { quantity: 1, actor: ACTORS.restorer }),
    (error) => error.code === "usage_exceeds_claim",
  );
});

test("服务恢复后待办、冻结原因与责任链仍可查询", async () => {
  const clock = clockAt("2026-09-22T08:00:00+08:00");
  const booted = await createTestService(clock);
  const { service, dir, store } = booted;
  await service.registerArtifact({ id: "artifact-0001", name: "受潮古籍", actor: ACTORS.admin });
  const order = await service.createWorkOrder({
    artifactId: "artifact-0001",
    title: "受潮古籍修复",
    actor: ACTORS.restorer,
  });
  await service.draftPlan(order.id, {
    content: { adhesive: "小麦淀粉浆", drying: "阴干 72 小时" },
    phases: [{ id: "backing", name: "补缀托裱" }],
    requiredExperts: 1,
    actor: ACTORS.restorer,
  });
  await service.countersignPlan(order.id, 1, { actor: ACTORS.expert1 });
  const op = `op_${order.id}_v1_backing`;
  await service.startOperation(op, { actor: ACTORS.restorer });
  await service.freezeOperation(op, { reason: "胶料变更，等待会签", actor: ACTORS.restorer });
  await service.registerMaterialLot({
    id: "lot-1",
    name: "甲基纤维素",
    supplier: "西泠文保材料公司",
    sourceEvidence: "COA-2026-11",
    quantity: 8,
    expiryDate: "2027-01-31",
    actor: ACTORS.admin,
  });
  await service.claimMaterial({ orderId: order.id, operationId: op, lotId: "lot-1", quantity: 2, actor: ACTORS.restorer2 });
  await service.close();

  // 新进程：同一事件日志重放
  const store2 = new EventStore({ dir });
  await store2.init();
  const restored = new RestorationService(store2, { now: clock.now });
  await restored.load();

  const todos = restored.listTodos();
  const todo = todos.find((t) => t.operationId === op);
  assert.equal(todo.status, "frozen");
  assert.equal(todo.frozenReason, "胶料变更，等待会签");

  const lot = await restored.getMaterialLot("lot-1");
  assert.equal(lot.reservedQuantity, 2);
  assert.equal(lot.availableQuantity, 6);

  const timeline = await restored.getTimeline("artifact-0001");
  const actorIds = timeline.responsibilityChain.map((entry) => entry.actor.id).sort();
  assert.deepEqual(actorIds, ["admin-1", "expert-1", "restorer-1", "restorer-2"]);
  const restorerActions = timeline.responsibilityChain.find((e) => e.actor.id === "restorer-1").actions;
  assert.ok(restorerActions.some((a) => a.type === "operation_frozen"));
});

test("管理员导出的时间线包含方案变更与其绑定的风险说明", async () => {
  const { service } = await createTestService();
  await service.registerArtifact({ id: "artifact-0001", name: "受潮古籍", actor: ACTORS.admin });
  const order = await service.createWorkOrder({
    artifactId: "artifact-0001",
    title: "受潮古籍修复",
    actor: ACTORS.restorer,
  });
  await service.draftPlan(order.id, {
    content: { adhesive: "小麦淀粉浆", drying: "阴干 72 小时" },
    phases: [{ id: "backing", name: "补缀托裱" }],
    requiredExperts: 1,
    actor: ACTORS.restorer,
  });
  await service.countersignPlan(order.id, 1, { actor: ACTORS.expert1 });
  await service.draftPlan(order.id, {
    content: { adhesive: "甲基纤维素", drying: "低湿烘干 6 小时" },
    phases: [{ id: "backing", name: "补缀托裱" }],
    risks: [{ description: "新旧胶料相容性风险", severity: "高" }],
    actor: ACTORS.restorer,
  });

  const timeline = await service.getTimeline("artifact-0001");
  const draftedEvents = timeline.events.filter((e) => e.type === "plan_drafted");
  assert.equal(draftedEvents.length, 2);
  assert.deepEqual(draftedEvents[1].data.risks, [{
    id: "risk_1",
    description: "新旧胶料相容性风险",
    severity: "高",
  }]);
  assert.equal(draftedEvents[1].data.basedOnVersion, 1);
  // 事件按 seq 严格有序
  for (let i = 1; i < timeline.events.length; i += 1) {
    assert.ok(timeline.events[i].seq > timeline.events[i - 1].seq);
  }
});
