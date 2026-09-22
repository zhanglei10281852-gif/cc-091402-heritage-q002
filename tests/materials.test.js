import assert from "node:assert/strict";
import test from "node:test";
import { createTestService, seedApprovedPlan, seedBatch, serviceAtFixedTime } from "./helpers.js";

async function activeFirstPhase(service, seeded) {
  const plan = service.getPlan(seeded.plan.planId);
  const cleaning = plan.instances.find((item) => item.code === "cleaning");
  await service.startPhase({ instanceId: cleaning.instanceId, actor: "restorer-wang" });
  return cleaning;
}

test("正常领用：扣减库存、记录用量并保存批次快照", async () => {
  const harness = await createTestService();
  test.after(harness.cleanup);
  const { service } = harness;
  const seeded = await seedApprovedPlan(service);
  const cleaning = await activeFirstPhase(service, seeded);
  await seedBatch(service, { quantity: 10 });
  const result = await service.requisitionMaterial({
    instanceId: cleaning.instanceId,
    batchId: "batch-0001",
    quantity: 2.5,
    purpose: "书口局部脱酸",
    actor: "restorer-chen",
  });
  assert.equal(result.remainingQuantity, 7.5);
  const batches = service.listBatches();
  assert.equal(batches[0].remainingQuantity, 7.5);
  const view = service.getInstance(cleaning.instanceId);
  assert.equal(view.requisitions.length, 1);
  assert.equal(view.requisitions[0].batchSnapshot.supplier, "故宫文保材料厂");
  assert.equal(view.requisitions[0].by, "restorer-chen");
});

test("并发领取同一批次：库存与用量最终一致，不超卖", async () => {
  const harness = await createTestService();
  test.after(harness.cleanup);
  const { service } = harness;
  const seeded = await seedApprovedPlan(service);
  const cleaning = await activeFirstPhase(service, seeded);
  await seedBatch(service, { quantity: 10 });

  // 10 个修复师各领 1，其中 2 人想再领 1（库存仅够 10 个单位）
  const attempts = [];
  for (let i = 0; i < 10; i += 1) {
    attempts.push(
      service.requisitionMaterial({
        instanceId: cleaning.instanceId,
        batchId: "batch-0001",
        quantity: 1,
        actor: `restorer-${i}`,
      }),
    );
  }
  const extra = service.requisitionMaterial({
    instanceId: cleaning.instanceId,
    batchId: "batch-0001",
    quantity: 1,
    actor: "restorer-late",
  });
  const results = await Promise.allSettled(attempts);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 10);

  await assert.rejects(extra, (error) => error.code === "insufficient_stock");
  const batch = service.listBatches()[0];
  assert.equal(batch.remainingQuantity, 0);
  assert.equal(batch.status, "depleted");
  assert.equal(batch.requisitionIds.length, 10);

  const view = service.getInstance(cleaning.instanceId);
  const total = view.requisitions.reduce((sum, item) => sum + item.quantity, 0);
  assert.equal(total, 10);
});

test("过期材料禁止领用，错误中带回有效期与当前时间", async () => {
  const harness = await createTestService();
  test.after(harness.cleanup);
  const { service } = harness;
  serviceAtFixedTime(service, "2026-09-22T10:00:00+08:00");
  const seeded = await seedApprovedPlan(service);
  const cleaning = await activeFirstPhase(service, seeded);
  await seedBatch(service, { expiresAt: "2026-09-01T00:00:00+08:00" });
  await assert.rejects(
    service.requisitionMaterial({
      instanceId: cleaning.instanceId,
      batchId: "batch-0001",
      quantity: 1,
      actor: "restorer-chen",
    }),
    (error) => {
      assert.equal(error.code, "batch_expired");
      assert.equal(error.details.expiresAt, "2026-08-31T16:00:00.000Z");
      return true;
    },
  );
  // 被拦截后库存不变
  assert.equal(service.listBatches()[0].remainingQuantity, 10);
});

test("来源不明（无供应商或质检证书）材料禁止入库后领用", async () => {
  const harness = await createTestService();
  test.after(harness.cleanup);
  const { service } = harness;
  const seeded = await seedApprovedPlan(service);
  const cleaning = await activeFirstPhase(service, seeded);
  await assert.rejects(
    service.registerMaterialBatch({
      batchId: "b-x",
      name: "来路不明浆糊",
      quantity: 1,
      unit: "g",
      expiresAt: "2099-01-01T00:00:00Z",
      actor: "keeper",
    }),
    (error) => error.code === "invalid_field",
  );
  // 登记时漏填证书号：入库被允许（登记只要求供应商），领用必须拦截
  await service.registerMaterialBatch({
    batchId: "b-nocert",
    name: "缺证书胶料",
    quantity: 1,
    unit: "g",
    expiresAt: "2099-01-01T00:00:00Z",
    supplier: "某供应商",
    actor: "keeper",
  });
  await assert.rejects(
    service.requisitionMaterial({
      instanceId: cleaning.instanceId,
      batchId: "b-nocert",
      quantity: 1,
      actor: "restorer-chen",
    }),
    (error) => error.code === "batch_origin_unknown",
  );
});

test("冻结/已完工工序不能领料；完工后再领料需先返工", async () => {
  const harness = await createTestService();
  test.after(harness.cleanup);
  const { service } = harness;
  const seeded = await seedApprovedPlan(service);
  const cleaning = await activeFirstPhase(service, seeded);
  await seedBatch(service);
  await service.completePhase({ instanceId: cleaning.instanceId, actor: "restorer-wang" });
  await assert.rejects(
    service.requisitionMaterial({
      instanceId: cleaning.instanceId,
      batchId: "batch-0001",
      quantity: 1,
      actor: "restorer-chen",
    }),
    (error) => error.code === "instance_closed",
  );
  const rework = await service.openRework({
    instanceId: cleaning.instanceId,
    reason: "质检发现局部残留霉斑",
    actor: "qc-li",
  });
  const result = await service.requisitionMaterial({
    instanceId: rework.newInstanceId,
    batchId: "batch-0001",
    quantity: 1,
    actor: "restorer-chen",
  });
  assert.equal(result.requisitionId.startsWith("req-"), true);
});
