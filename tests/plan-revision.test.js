import assert from "node:assert/strict";
import test from "node:test";
import { createTestService, seedApprovedPlan } from "./helpers.js";

test("方案修订：已开工工序保持原样继续执行，未开工工序冻结并生成接替实例", async () => {
  const harness = await createTestService();
  test.after(harness.cleanup);
  const { service } = harness;
  const seeded = await seedApprovedPlan(service);

  // 按依赖顺序开工第一道工序
  const v1 = service.getPlan(seeded.plan.planId);
  const cleaning = v1.instances.find((item) => item.code === "cleaning");
  await service.startPhase({ instanceId: cleaning.instanceId, actor: "restorer-wang" });
  await service.completePhase({
    instanceId: cleaning.instanceId,
    actor: "restorer-wang",
    result: "霉斑清理完成",
  });

  // 第二道工序脱酸开工 —— 此时方案临时改变胶料与干燥步骤
  const deacid = v1.instances.find((item) => item.code === "deacidification");
  await service.startPhase({ instanceId: deacid.instanceId, actor: "restorer-wang" });

  const v2 = await service.draftPlan({
    workOrderId: seeded.wo.workOrderId,
    actor: "restorer-wang",
    changeSummary: "胶料由小麦淀粉浆改为甲基纤维素；干燥改为低温真空干燥",
    riskNote: {
      summary: "新旧胶料相容性未经长期验证，可能产生色差",
      affectedPhases: ["drying"],
      mitigations: "小样试验 24 小时后再大面积施工，保留对照样页",
      residualRisk: "色差 ΔE 可能高于 1.5",
    },
    phases: [
      { code: "cleaning", name: "表面除尘与霉斑清理" },
      { code: "deacidification", name: "脱酸处理（沿用在制批次）", dependsOn: ["cleaning"] },
      { code: "drying", name: "低温真空干燥（原恒湿干燥）", dependsOn: ["deacidification"] },
      { code: "pressing", name: "压平定型", dependsOn: ["drying"] },
    ],
    materials: [
      { name: "甲基纤维素", plannedQuantity: 300, unit: "g" },
      { name: "脱酸剂 A", plannedQuantity: 2, unit: "L" },
    ],
  });
  await service.submitPlan({ planId: v2.planId, actor: "restorer-wang" });
  await service.countersign({ planId: v2.planId, actor: "expert-zhao", decision: "approve" });
  await service.countersign({ planId: v2.planId, actor: "expert-qian", decision: "approve", comment: "须做小样对照" });
  const decision = await service.decidePlan({ planId: v2.planId, actor: "director-sun" });

  // 已完工的 cleaning 与施工中的 deacid 沿用，未重复生成
  assert.deepEqual(decision.carriedOver.map((item) => item.code).sort(), ["cleaning", "deacidification"]);
  // 旧 drying(pending) 冻结；新增 vacuum_drying / pressing 生成待办
  assert.equal(decision.frozen.length, 1);
  assert.equal(decision.spawned.length, 2);

  const oldDrying = service.getInstance(v1.instances.find((item) => item.code === "drying").instanceId);
  assert.equal(oldDrying.status, "frozen");
  assert.equal(oldDrying.frozenReason.kind, "plan_superseded");
  assert.ok(oldDrying.frozenReason.note.includes("胶料"));
  assert.equal(oldDrying.frozenReason.newPlanId, v2.planId);
  assert.ok(oldDrying.supersededByInstanceId, "冻结记录应指向接替实例");

  // 已开工的脱酸工序没有被静默改写：仍是 active，经办人/开工时间保留
  const sameDeacid = service.getInstance(deacid.instanceId);
  assert.equal(sameDeacid.status, "active");
  assert.equal(sameDeacid.startedBy, "restorer-wang");
  assert.equal(sameDeacid.planId, seeded.plan.planId);

  // 施工中的旧脱酸工序可以继续完工
  await service.completePhase({ instanceId: deacid.instanceId, actor: "restorer-wang", result: "完成" });

  // 待办列表：drying 已就绪（依赖 done），pressing 被 drying 阻塞
  const todos = service.listTodos({ workOrderId: seeded.wo.workOrderId });
  const drying = todos.find((item) => item.code === "drying");
  const pressing = todos.find((item) => item.code === "pressing");
  assert.equal(drying.ready, true);
  assert.equal(drying.name, "低温真空干燥（原恒湿干燥）");
  assert.deepEqual(pressing.blocking, ["drying"]);

  // 冻结原因在工单视图中仍可查询
  const wo = service.getWorkOrder(seeded.wo.workOrderId);
  assert.equal(wo.frozenRecords.length, 1);
  assert.equal(wo.frozenRecords[0].code, "drying");
  assert.equal(wo.currentPlanId, v2.planId);
});

test("前版方案尚在会签流程中时，不允许另起修订稿", async () => {
  const harness = await createTestService();
  test.after(harness.cleanup);
  const { service } = harness;
  const seeded = await seedApprovedPlan(service);
  const draft = await service.draftPlan({
    workOrderId: seeded.wo.workOrderId,
    actor: "restorer-wang",
    changeSummary: "试验性调整",
    riskNote: { summary: "风险", mitigations: "措施" },
    phases: [{ code: "cleaning", name: "清理" }],
  });
  await service.submitPlan({ planId: draft.planId, actor: "restorer-wang" });
  await assert.rejects(
    service.draftPlan({
      workOrderId: seeded.wo.workOrderId,
      actor: "restorer-wang",
      changeSummary: "再调整",
      riskNote: { summary: "风险", mitigations: "措施" },
      phases: [{ code: "cleaning", name: "清理" }],
    }),
    (error) => error.code === "prior_plan_not_decided",
  );
});
