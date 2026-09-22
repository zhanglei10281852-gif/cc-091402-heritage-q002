import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createTestService, seedApprovedPlan, seedBatch } from "./helpers.js";
import { verifyChain } from "../src/domain/events.js";
import { EventStore } from "../src/domain/store.js";
import { RestorationService } from "../src/domain/service.js";
import { DomainError } from "../src/domain/errors.js";

test("服务重启后：待办、冻结原因、库存、责任链均可查询", async () => {
  const harness = await createTestService();
  test.after(harness.cleanup);
  const { service, reopen } = harness;
  const seeded = await seedApprovedPlan(service);
  const plan = service.getPlan(seeded.plan.planId);
  const cleaning = plan.instances.find((item) => item.code === "cleaning");
  const deacid = plan.instances.find((item) => item.code === "deacidification");
  await service.startPhase({ instanceId: cleaning.instanceId, actor: "restorer-wang" });
  await service.completePhase({ instanceId: cleaning.instanceId, actor: "restorer-wang" });
  await service.startPhase({ instanceId: deacid.instanceId, actor: "restorer-chen" });
  await seedBatch(service, { quantity: 5 });
  await service.requisitionMaterial({
    instanceId: deacid.instanceId,
    batchId: "batch-0001",
    quantity: 2,
    actor: "restorer-chen",
  });

  // 方案修订，冻结未开工的 drying
  const v2 = await service.draftPlan({
    workOrderId: seeded.wo.workOrderId,
    actor: "restorer-wang",
    changeSummary: "调整干燥步骤",
    riskNote: { summary: "风险可控", mitigations: "慢速阴干" },
    phases: [
      { code: "cleaning", name: "清理" },
      { code: "deacidification", name: "脱酸", dependsOn: ["cleaning"] },
      { code: "air_dry", name: "阴干", dependsOn: ["deacidification"] },
    ],
  });
  await service.submitPlan({ planId: v2.planId, actor: "restorer-wang" });
  await service.countersign({ planId: v2.planId, actor: "expert-zhao", decision: "approve" });
  await service.countersign({ planId: v2.planId, actor: "expert-qian", decision: "approve" });
  await service.decidePlan({ planId: v2.planId, actor: "director-sun" });

  // 重启
  const restored = await reopen();

  const todos = restored.listTodos({ workOrderId: seeded.wo.workOrderId });
  assert.deepEqual(
    todos.map((item) => item.code).sort(),
    ["air_dry"],
  );
  assert.equal(todos[0].ready, false, "脱酸仍在施工中，阴干依赖未满足");

  const wo = restored.getWorkOrder(seeded.wo.workOrderId);
  assert.equal(wo.frozenRecords.length, 1);
  assert.equal(wo.frozenRecords[0].code, "drying");
  assert.equal(wo.frozenRecords[0].reason.includes("调整干燥步骤"), true);

  const batch = restored.listBatches().find((item) => item.batchId === "batch-0001");
  assert.equal(batch.remainingQuantity, 3);
  assert.equal(batch.requisitionIds.length, 1);

  // 责任链：领料记录保留经办人，方案变更链可追
  const oldDryingId = wo.frozenRecords[0].instanceId;
  const oldDrying = restored.getInstance(oldDryingId);
  assert.equal(oldDrying.status, "frozen");
  assert.equal(oldDrying.frozenReason.by ?? wo.frozenRecords[0].by, "director-sun");
  assert.equal(wo.frozenRecords[0].by, "director-sun");

  // 重启后服务仍可继续处理命令，哈希链接续
  const activeDeacid = wo.instances.find((item) => item.code === "deacidification" && item.status === "active");
  await restored.completePhase({ instanceId: activeDeacid.instanceId, actor: "restorer-chen" });
  assert.equal(restored.listTodos({ workOrderId: seeded.wo.workOrderId })[0].ready, true);
});

test("日志哈希链完整可验；篡改任一字段将导致服务拒绝启动", async () => {
  const harness = await createTestService();
  test.after(harness.cleanup);
  const { service, dataFile } = harness;
  await seedApprovedPlan(service);

  const raw = await readFile(dataFile, "utf8");
  const events = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(verifyChain(events).ok, true);

  // 篡改：把某条领料/方案事件的经办人改掉
  const target = events.find((event) => event.type === "plan_approved");
  target.actor = "attacker";
  const corrupted = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  const { writeFile } = await import("node:fs/promises");
  await writeFile(dataFile, corrupted);

  const store = new EventStore(dataFile);
  const rebuilt = new RestorationService({ store });
  await assert.rejects(rebuilt.init(), (error) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, "chain_broken");
    return true;
  });
});

test("管理员可导出文物的完整修复时间线（JSON 与 CSV）", async () => {
  const harness = await createTestService();
  test.after(harness.cleanup);
  const { service } = harness;
  const seeded = await seedApprovedPlan(service);
  const plan = service.getPlan(seeded.plan.planId);
  const cleaning = plan.instances.find((item) => item.code === "cleaning");
  await service.startPhase({ instanceId: cleaning.instanceId, actor: "restorer-wang" });
  await service.completePhase({ instanceId: cleaning.instanceId, actor: "restorer-wang" });
  await service.recordQc({
    instanceId: cleaning.instanceId,
    stage: "repair_after",
    result: "pass",
    actor: "qc-li",
  });
  await service.openRework({
    instanceId: cleaning.instanceId,
    reason: "抽样复查发现色差",
    actor: "qc-li",
  });

  const timeline = service.getTimeline("artifact-0001");
  const types = timeline.events.map((event) => event.type);
  assert.ok(types.includes("plan_draft_created"));
  assert.ok(types.includes("plan_approved"));
  assert.ok(types.includes("rework_opened"));
  // 方案变更与其风险说明在同一条事件中绑定
  const draft = timeline.events.find((event) => event.type === "plan_draft_created");
  assert.ok(draft.payload.riskNote.summary.length > 0);
  assert.ok(draft.summary.includes("风险"));
  // 责任链：每一条都有经办人、时间、前后哈希
  assert.ok(timeline.events.every((event) => event.actor && event.at && event.prev && event.hash));

  const csv = service.exportTimelineCsv("artifact-0001");
  assert.ok(csv.startsWith("﻿"));
  const lines = csv.split("\r\n");
  assert.equal(lines[0].split(",").length, 11);
  assert.equal(lines.length, timeline.events.length + 1);
  assert.ok(lines.some((line) => line.includes("返工")));

  // 未知文物 404
  assert.throws(() => service.getTimeline("nope"), (error) => error.code === "not_found");
});
