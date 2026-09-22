import assert from "node:assert/strict";
import test from "node:test";
import { createTestService, seedApprovedPlan } from "./helpers.js";

async function finishPhase(service, instanceId, actor = "restorer-wang") {
  await service.startPhase({ instanceId, actor });
  await service.completePhase({ instanceId, actor, result: "完工" });
}

test("返工生成新工序实例，原施工与质控记录完整保留", async () => {
  const harness = await createTestService();
  test.after(harness.cleanup);
  const { service } = harness;
  const seeded = await seedApprovedPlan(service);
  const plan = service.getPlan(seeded.plan.planId);
  const cleaning = plan.instances.find((item) => item.code === "cleaning");
  await finishPhase(service, cleaning.instanceId);
  await service.recordQc({
    instanceId: cleaning.instanceId,
    stage: "repair_after",
    result: "fail",
    findings: "局部仍有霉斑",
    actor: "qc-li",
  });

  const rework = await service.openRework({
    instanceId: cleaning.instanceId,
    reason: "验收不合格：书口霉斑残留",
    actor: "qc-li",
  });

  // 原实例不被覆盖
  const origin = service.getInstance(cleaning.instanceId);
  assert.equal(origin.status, "done");
  assert.equal(origin.completedBy, "restorer-wang");
  assert.deepEqual(origin.reworkInstanceIds, [rework.newInstanceId]);
  assert.equal(origin.qcRecords.length, 1);
  assert.equal(origin.qcRecords[0].result, "fail");

  const fresh = service.getInstance(rework.newInstanceId);
  assert.equal(fresh.status, "pending");
  assert.equal(fresh.originInstanceId, cleaning.instanceId);
  assert.equal(fresh.reworkReason, "验收不合格：书口霉斑残留");
  assert.equal(fresh.code, "cleaning");
  assert.deepEqual(fresh.requisitions, []);

  // 返工实例可独立走施工流程
  await finishPhase(service, rework.newInstanceId, "restorer-chen");
  await service.recordQc({
    instanceId: rework.newInstanceId,
    stage: "acceptance",
    result: "pass",
    findings: "复验合格",
    measurements: [{ metric: "含水率", value: 6.8, unit: "%" }],
    actor: "qc-li",
  });
  const done = service.getInstance(rework.newInstanceId);
  assert.equal(done.status, "done");
  assert.equal(done.startedBy, "restorer-chen");
  assert.equal(done.qcRecords[0].result, "pass");

  // 原实例质控记录仍然存在
  assert.equal(service.getInstance(cleaning.instanceId).qcRecords[0].result, "fail");
});

test("工序依赖未满足不能开工", async () => {
  const harness = await createTestService();
  test.after(harness.cleanup);
  const { service } = harness;
  const seeded = await seedApprovedPlan(service);
  const plan = service.getPlan(seeded.plan.planId);
  const drying = plan.instances.find((item) => item.code === "drying");
  await assert.rejects(
    service.startPhase({ instanceId: drying.instanceId, actor: "restorer-wang" }),
    (error) => {
      assert.equal(error.code, "dependencies_unmet");
      assert.deepEqual(error.details.blocking, ["deacidification"]);
      return true;
    },
  );
});

test("已开始的工序不能被跳过", async () => {
  const harness = await createTestService();
  test.after(harness.cleanup);
  const { service } = harness;
  const seeded = await seedApprovedPlan(service);
  const plan = service.getPlan(seeded.plan.planId);
  const cleaning = plan.instances.find((item) => item.code === "cleaning");
  await service.startPhase({ instanceId: cleaning.instanceId, actor: "restorer-wang" });
  await assert.rejects(
    service.skipPhase({ instanceId: cleaning.instanceId, reason: "不做了", actor: "restorer-wang" }),
    (error) => error.code === "phase_started_no_skip",
  );
});
