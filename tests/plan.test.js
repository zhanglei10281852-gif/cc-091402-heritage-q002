import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../src/lib/errors.js";
import { createTestService, ACTORS } from "./helpers.js";

async function bootOrder() {
  const { service, dir } = await createTestService();
  const artifact = await service.registerArtifact({
    id: "artifact-0001",
    name: "受潮宋版《文选》残卷",
    measurements: { 含水率: 18.2, pH: 5.4 },
    actor: ACTORS.admin,
  });
  const order = await service.createWorkOrder({
    artifactId: artifact.id,
    title: "2026 年受潮古籍首批修复",
    actor: ACTORS.restorer,
  });
  return { service, dir, order };
}

const OLD_PLAN = {
  content: { adhesive: "小麦淀粉浆", drying: "阴干 72 小时" },
  phases: [
    { id: "clean", name: "表面去污除霉" },
    { id: "backing", name: "补缀托裱", dependsOn: ["clean"] },
    { id: "dry", name: "干燥定型", dependsOn: ["backing"] },
  ],
  requiredExperts: 2,
};

test("首版方案草拟后经专家会签达到人数即生效并生成工序", async () => {
  const { service, order } = await bootOrder();
  const plan = await service.draftPlan(order.id, { ...OLD_PLAN, actor: ACTORS.restorer });
  assert.equal(plan.version, 1);
  assert.equal(plan.status, "draft");

  await service.countersignPlan(order.id, 1, { actor: ACTORS.expert1 });
  const afterOne = await service.getPlan(order.id, 1);
  assert.equal(afterOne.status, "draft");

  await service.countersignPlan(order.id, 1, { actor: ACTORS.expert2 });
  const approved = await service.getPlan(order.id, 1);
  assert.equal(approved.status, "approved");
  assert.equal(approved.countersignatures.length, 2);

  const detail = await service.getWorkOrder(order.id);
  assert.equal(detail.operations.length, 3);
  assert.deepEqual(detail.operations.map((op) => op.phaseId), ["clean", "backing", "dry"]);
});

test("非专家不能会签且专家不能重复会签", async () => {
  const { service, order } = await bootOrder();
  await service.draftPlan(order.id, { ...OLD_PLAN, actor: ACTORS.restorer });
  await assert.rejects(
    service.countersignPlan(order.id, 1, { actor: ACTORS.restorer }),
    (error) => error instanceof DomainError && error.code === "forbidden",
  );
  await service.countersignPlan(order.id, 1, { actor: ACTORS.expert1 });
  await assert.rejects(
    service.countersignPlan(order.id, 1, { actor: ACTORS.expert1 }),
    (error) => error instanceof DomainError && error.code === "already_countersigned",
  );
});

test("方案变更必须绑定风险说明，并检测基于旧版本的并发草拟", async () => {
  const { service, order } = await bootOrder();
  await service.draftPlan(order.id, { ...OLD_PLAN, actor: ACTORS.restorer });
  await service.countersignPlan(order.id, 1, { actor: ACTORS.expert1 });
  await service.countersignPlan(order.id, 1, { actor: ACTORS.expert2 });

  // 没有风险说明 -> 拒绝
  await assert.rejects(
    service.draftPlan(order.id, {
      ...OLD_PLAN,
      content: { adhesive: "甲基纤维素", drying: OLD_PLAN.content.drying },
      actor: ACTORS.restorer,
    }),
    (error) => error instanceof DomainError && error.code === "risk_required",
  );

  // 与当前版本完全一致 -> 不构成变更
  await assert.rejects(
    service.draftPlan(order.id, {
      ...OLD_PLAN,
      risks: [{ description: "换胶风险", severity: "高" }],
      actor: ACTORS.restorer,
    }),
    (error) => error instanceof DomainError && error.code === "no_change",
  );

  // 有人已经基于 v1 草拟了 v2，另一人仍按 basedOnVersion=1 提交 -> 版本冲突
  await service.draftPlan(order.id, {
    ...OLD_PLAN,
    content: { adhesive: "甲基纤维素", drying: "阴干 48 小时后低湿烘干 6 小时" },
    risks: [{ description: "新胶料与旧糨糊相容性未知，可能产生色差", severity: "高" }],
    actor: ACTORS.restorer,
  });
  await assert.rejects(
    service.draftPlan(order.id, {
      ...OLD_PLAN,
      basedOnVersion: 1,
      content: { adhesive: "明胶稀液", drying: OLD_PLAN.content.drying },
      risks: [{ description: "明胶易霉变", severity: "中" }],
      actor: ACTORS.restorer2,
    }),
    (error) => error instanceof DomainError && error.code === "version_conflict",
  );
});

test("已开始的工序不能被静默改写，只能走返工", async () => {
  const { service, order } = await bootOrder();
  await service.draftPlan(order.id, { ...OLD_PLAN, actor: ACTORS.restorer });
  await service.countersignPlan(order.id, 1, { actor: ACTORS.expert1 });
  await service.countersignPlan(order.id, 1, { actor: ACTORS.expert2 });

  const clean = `op_${order.id}_v1_clean`;
  await service.startOperation(clean, { actor: ACTORS.restorer });
  await service.completeOperation(clean, { actor: ACTORS.restorer });
  await service.startOperation(`op_${order.id}_v1_backing`, { actor: ACTORS.restorer });

  await assert.rejects(
    service.draftPlan(order.id, {
      ...OLD_PLAN,
      content: { adhesive: "甲基纤维素", drying: "阴干 48 小时后低湿烘干 6 小时" },
      risks: [{ description: "临时更换胶料影响已补缀部位", severity: "高" }],
      actor: ACTORS.restorer,
    }),
    (error) => error instanceof DomainError && error.code === "plan_locked",
  );
});

test("方案必须明确胶料与干燥步骤，工序依赖不能有环", async () => {
  const { service, order } = await bootOrder();
  await assert.rejects(
    service.draftPlan(order.id, {
      content: { drying: "阴干 72 小时" },
      phases: OLD_PLAN.phases,
      actor: ACTORS.restorer,
    }),
    (error) => error.code === "invalid_content",
  );
  await assert.rejects(
    service.draftPlan(order.id, {
      content: { adhesive: "小麦淀粉浆", drying: "阴干 72 小时" },
      phases: [
        { id: "a", name: "甲", dependsOn: ["b"] },
        { id: "b", name: "乙", dependsOn: ["a"] },
      ],
      actor: ACTORS.restorer,
    }),
    (error) => error.code === "cyclic_dependency",
  );
});
