import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../src/lib/errors.js";
import { createTestService, ACTORS } from "./helpers.js";

async function approvedOrder() {
  const booted = await createTestService();
  const { service } = booted;
  await service.registerArtifact({ id: "artifact-0001", name: "受潮古籍", actor: ACTORS.admin });
  const order = await service.createWorkOrder({
    artifactId: "artifact-0001",
    title: "受潮古籍修复",
    actor: ACTORS.restorer,
  });
  await service.draftPlan(order.id, {
    content: { adhesive: "小麦淀粉浆", drying: "阴干 72 小时" },
    phases: [
      { id: "clean", name: "表面去污除霉" },
      { id: "backing", name: "补缀托裱", dependsOn: ["clean"] },
    ],
    requiredExperts: 1,
    actor: ACTORS.restorer,
  });
  await service.countersignPlan(order.id, 1, { actor: ACTORS.expert1 });
  return { ...booted, order };
}

test("工序依赖未完成不能开工；完工后可质控验收", async () => {
  const { service, order } = await approvedOrder();
  const backing = `op_${order.id}_v1_backing`;
  await assert.rejects(
    service.startOperation(backing, { actor: ACTORS.restorer }),
    (error) => error instanceof DomainError && error.code === "dependencies_unmet",
  );

  const clean = `op_${order.id}_v1_clean`;
  await service.startOperation(clean, { actor: ACTORS.restorer });
  await service.completeOperation(clean, { actor: ACTORS.restorer });
  await service.inspectOperation(clean, {
    passed: true,
    sample: { id: "sample-A1", expected: { pH: 6.5 }, actual: { pH: 6.7 } },
    findings: "色差在允许范围内",
    actor: { id: "qc-1", role: "质控", name: "赵质控" },
  });
  const op = await service.getOperation(clean);
  assert.equal(op.status, "accepted");
  assert.equal(op.inspections[0].sample.id, "sample-A1");

  await service.startOperation(backing, { actor: ACTORS.restorer });
  assert.equal((await service.getOperation(backing)).status, "in_progress");
});

test("冻结原因可查，解除冻结后继续施工，历史冻结均保留", async () => {
  const { service, order } = await approvedOrder();
  const clean = `op_${order.id}_v1_clean`;
  await service.startOperation(clean, { actor: ACTORS.restorer });
  await service.freezeOperation(clean, { reason: "临时更换胶料，等待新材料批次检验", actor: ACTORS.restorer });

  const todos = service.listTodos();
  const frozenTodo = todos.find((todo) => todo.operationId === clean);
  assert.equal(frozenTodo.status, "frozen");
  assert.equal(frozenTodo.frozenReason, "临时更换胶料，等待新材料批次检验");

  await assert.rejects(
    service.completeOperation(clean, { actor: ACTORS.restorer }),
    (error) => error.code === "invalid_status",
  );
  await service.resumeOperation(clean, { note: "新批次检验合格", actor: ACTORS.restorer });
  await service.completeOperation(clean, { actor: ACTORS.restorer });

  const op = await service.getOperation(clean);
  assert.equal(op.freezeHistory.length, 1);
  assert.equal(op.freezeHistory[0].resumeNote, "新批次检验合格");
});

test("验收不通过后返工：会签通过生成新一代工序实例，原记录不被覆盖", async () => {
  const { service, order } = await approvedOrder();
  const clean = `op_${order.id}_v1_clean`;
  await service.startOperation(clean, { actor: ACTORS.restorer });
  await service.completeOperation(clean, { actor: ACTORS.restorer });
  await service.inspectOperation(clean, {
    passed: false,
    sample: { id: "sample-A2", expected: { 含水率: 8 }, actual: { 含水率: 12 } },
    findings: "含水量超标，需重新干燥处理",
    actor: { id: "qc-1", role: "质控", name: "赵质控" },
  });

  const rework = await service.requestRework(clean, {
    reason: "干燥不充分，含水率超标",
    change: { adhesive: "小麦淀粉浆", drying: "阴干 96 小时并翻页 4 次" },
    risks: [{ description: "二次润湿可能导致墨迹晕散", severity: "高" }],
    requiredExperts: 1,
    actor: ACTORS.restorer,
  });
  assert.equal(rework.status, "awaiting_countersign");
  await service.countersignRework(rework.id, { actor: ACTORS.expert1 });

  const approved = await service.getRework(rework.id);
  assert.equal(approved.status, "approved");
  assert.ok(approved.newOperationId);
  assert.notEqual(approved.newOperationId, clean);

  const detail = await service.getWorkOrder(order.id);
  const original = detail.operations.find((op) => op.id === clean);
  const next = detail.operations.find((op) => op.id === approved.newOperationId);
  // 原工序保持 rejected，未被覆盖
  assert.equal(original.status, "rejected");
  assert.equal(original.generation, 1);
  assert.equal(next.status, "pending");
  assert.equal(next.generation, 2);
  assert.equal(next.reworkOf, clean);
  assert.equal(next.reworkId, rework.id);

  // 新实例可以独立走一遍施工流程
  await service.startOperation(next.id, { actor: ACTORS.restorer2 });
  assert.equal((await service.getOperation(next.id)).status, "in_progress");

  // 原实例已失活：保留 rejected 事实，但不能再领料、不再占用待办
  assert.equal(original.active, false);
  assert.equal(original.supersededBy, `rework:${rework.id}`);
  await service.registerMaterialLot({
    id: "lot-x",
    name: "淀粉浆",
    supplier: "西泠文保材料公司",
    sourceEvidence: "COA-X",
    quantity: 5,
    expiryDate: "2026-12-31",
    actor: ACTORS.admin,
  });
  await assert.rejects(
    service.claimMaterial({ orderId: order.id, operationId: clean, lotId: "lot-x", quantity: 1, actor: ACTORS.restorer }),
    (error) => error.code === "operation_inactive",
  );
  const todoIds = service.listTodos().map((todo) => todo.operationId);
  assert.ok(!todoIds.includes(clean));
  assert.ok(todoIds.includes(next.id));
});

test("返工必须绑定风险说明且只有完工/拒收工序可返工", async () => {
  const { service, order } = await approvedOrder();
  const clean = `op_${order.id}_v1_clean`;
  await service.startOperation(clean, { actor: ACTORS.restorer });
  await assert.rejects(
    service.requestRework(clean, { reason: "x", risks: [{ description: "r" }], actor: ACTORS.restorer }),
    (error) => error.code === "invalid_status",
  );
  await service.completeOperation(clean, { actor: ACTORS.restorer });
  await assert.rejects(
    service.requestRework(clean, { reason: "x", risks: [], actor: ACTORS.restorer }),
    (error) => error.code === "risk_required",
  );
});
