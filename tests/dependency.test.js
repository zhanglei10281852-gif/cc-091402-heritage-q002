import assert from "node:assert/strict";
import test from "node:test";
import { createTestService, seedApprovedPlan } from "./helpers.js";

test("上游工序返工时，下游必须等待返工实例完工", async () => {
  const harness = await createTestService();
  test.after(harness.cleanup);
  const { service } = harness;
  const seeded = await seedApprovedPlan(service);
  const plan = service.getPlan(seeded.plan.planId);
  const cleaning = plan.instances.find((item) => item.code === "cleaning");
  const deacid = plan.instances.find((item) => item.code === "deacidification");
  const drying = plan.instances.find((item) => item.code === "drying");

  // cleaning 完工 -> 质控不合格 -> 返工
  await service.startPhase({ instanceId: cleaning.instanceId, actor: "w1" });
  await service.completePhase({ instanceId: cleaning.instanceId, actor: "w1" });
  await service.recordQc({
    instanceId: cleaning.instanceId,
    stage: "repair_after",
    result: "fail",
    actor: "qc",
  });
  const rework = await service.openRework({
    instanceId: cleaning.instanceId,
    reason: "霉斑残留",
    actor: "qc",
  });

  // 即使旧 cleaning 已 done，deacidification 此时不能开工（最新 cleaning 是 pending 的返工实例）
  await assert.rejects(
    service.startPhase({ instanceId: deacid.instanceId, actor: "w2" }),
    (error) => {
      assert.equal(error.code, "dependencies_unmet");
      assert.deepEqual(error.details.blocking, ["cleaning"]);
      return true;
    },
  );

  // 返工完工后，下游放行
  await service.startPhase({ instanceId: rework.newInstanceId, actor: "w3" });
  await service.completePhase({ instanceId: rework.newInstanceId, actor: "w3" });
  await service.startPhase({ instanceId: deacid.instanceId, actor: "w2" });
  await service.completePhase({ instanceId: deacid.instanceId, actor: "w2" });
  // drying 依赖 deacidification（无返工），可以开工
  const result = await service.startPhase({ instanceId: drying.instanceId, actor: "w2" });
  assert.equal(result.status, "active");
});

test("跳过的工序也算依赖了结（可在待办中放行下游）", async () => {
  const harness = await createTestService();
  test.after(harness.cleanup);
  const { service } = harness;
  const seeded = await seedApprovedPlan(service, {
    phases: [
      { code: "a", name: "甲" },
      { code: "b", name: "乙", dependsOn: ["a"] },
    ],
    materials: [{ name: "m", plannedQuantity: 1, unit: "g" }],
  });
  const plan = service.getPlan(seeded.plan.planId);
  const a = plan.instances.find((item) => item.code === "a");
  const b = plan.instances.find((item) => item.code === "b");
  await service.skipPhase({ instanceId: a.instanceId, reason: "本批次无需处理", actor: "w1" });
  const result = await service.startPhase({ instanceId: b.instanceId, actor: "w2" });
  assert.equal(result.status, "active");
});
