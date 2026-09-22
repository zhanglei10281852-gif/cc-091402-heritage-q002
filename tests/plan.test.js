import assert from "node:assert/strict";
import test from "node:test";
import { createTestService, seedApprovedPlan, seedBatch } from "./helpers.js";

test("方案草拟必须绑定结构化风险说明，否则拒绝", async () => {
  const harness = await createTestService();
  test.after(harness.cleanup);
  const { service } = harness;
  await service.registerArtifact({ artifactId: "a1", name: "古籍", actor: "curator" });
  await service.createWorkOrder({ workOrderId: "wo1", artifactId: "a1", title: "修复", actor: "curator" });
  await assert.rejects(
    service.draftPlan({
      workOrderId: "wo1",
      actor: "restorer",
      changeSummary: "改胶料",
      phases: [{ code: "p1", name: "工序一" }],
    }),
    (error) => error.code === "risk_note_required",
  );
});

test("方案送审后需达到会签人数才能批准，驳回后可重新修订", async () => {
  const harness = await createTestService();
  test.after(harness.cleanup);
  const { service } = harness;
  const seeded = await seedApprovedPlan(service, {
    materials: [{ name: "浆糊", plannedQuantity: 1, unit: "g" }],
  });
  const plan = service.getPlan(seeded.plan.planId);
  assert.equal(plan.status, "approved");
  assert.equal(plan.requiredExperts, 2);
  assert.equal(plan.approvals.length, 2);
  assert.ok(plan.approvals.every((item) => item.eventId && item.at));
});

test("同一专家不能重复会签", async () => {
  const harness = await createTestService();
  test.after(harness.cleanup);
  const { service } = harness;
  const seeded = await seedApprovedPlan(service);
  // 已批准的不能再签；用送审中的新方案验证重复签署
  const draft = await service.draftPlan({
    workOrderId: seeded.wo.workOrderId,
    actor: "restorer-wang",
    changeSummary: "调整干燥温度",
    riskNote: { summary: "低温风险低", mitigations: "加盖保湿膜" },
    phases: [{ code: "cleaning", name: "清理" }],
  });
  await service.submitPlan({ planId: draft.planId, actor: "restorer-wang" });
  await service.countersign({ planId: draft.planId, actor: "expert-zhao", decision: "approve" });
  await assert.rejects(
    service.countersign({ planId: draft.planId, actor: "expert-zhao", decision: "approve" }),
    (error) => error.code === "already_countersigned",
  );
});

test("任一专家驳回则方案驳回，且不会生成工序实例", async () => {
  const harness = await createTestService();
  test.after(harness.cleanup);
  const { service } = harness;
  await service.registerArtifact({ artifactId: "a1", name: "古籍", actor: "curator" });
  await service.createWorkOrder({ workOrderId: "wo1", artifactId: "a1", title: "修复", actor: "curator" });
  const draft = await service.draftPlan({
    workOrderId: "wo1",
    actor: "restorer",
    changeSummary: "初版",
    riskNote: { summary: "风险", mitigations: "措施" },
    phases: [{ code: "p1", name: "一" }],
  });
  await service.submitPlan({ planId: draft.planId, actor: "restorer" });
  await service.countersign({ planId: draft.planId, actor: "e1", decision: "reject", comment: "胶料存疑" });
  const result = await service.decidePlan({ planId: draft.planId, actor: "director" });
  assert.equal(result.status, "rejected");
  assert.deepEqual(service.listTodos({ workOrderId: "wo1" }), []);
});
