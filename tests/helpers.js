import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventStore } from "../src/domain/store.js";
import { RestorationService } from "../src/domain/service.js";

/** 创建基于临时目录事件日志的服务实例 */
export async function createTestService() {
  const dir = await mkdtemp(path.join(tmpdir(), "restoration-"));
  const dataFile = path.join(dir, "events.jsonl");
  const store = new EventStore(dataFile);
  const service = new RestorationService({ store });
  await service.init();
  return {
    service,
    dataFile,
    async reopen() {
      const nextStore = new EventStore(dataFile);
      const next = new RestorationService({ store: nextStore });
      await next.init();
      return next;
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** 走到“方案批准、工序实例已生成”的标准状态 */
export async function seedApprovedPlan(service, input = {}) {
  const artifact = await service.registerArtifact({
    artifactId: input.artifactId ?? "artifact-0001",
    name: input.artifactName ?? "受潮古籍《千字文》",
    actor: "curator-li",
    initialCondition: "书口霉变，纸张含水率偏高",
    measurements: [{ metric: "含水率", value: 18.2, unit: "%", stage: "repair_before" }],
  });
  const wo = await service.createWorkOrder({
    workOrderId: input.workOrderId ?? "wo-0001",
    artifactId: artifact.artifactId,
    title: "受潮古籍脱酸修复",
    actor: "curator-li",
  });
  const plan = await service.draftPlan({
    workOrderId: wo.workOrderId,
    actor: "restorer-wang",
    changeSummary: "初版方案：清洗、脱酸、干燥",
    riskNote: {
      summary: "脱水过快可能引起纸页翘曲",
      affectedPhases: ["drying"],
      mitigations: "低温恒湿分阶段干燥，每 12 小时记录含水率",
    },
    phases: input.phases ?? [
      { code: "cleaning", name: "表面除尘与霉斑清理" },
      { code: "deacidification", name: "脱酸处理", dependsOn: ["cleaning"] },
      { code: "drying", name: "恒湿干燥", dependsOn: ["deacidification"] },
    ],
    materials: input.materials ?? [
      { name: "脱酸剂 A", plannedQuantity: 2, unit: "L" },
      { name: "小麦淀粉浆", plannedQuantity: 500, unit: "g" },
    ],
  });
  await service.submitPlan({ planId: plan.planId, actor: "restorer-wang" });
  const experts = input.experts ?? ["expert-zhao", "expert-qian"];
  for (const expert of experts) {
    await service.countersign({ planId: plan.planId, actor: expert, decision: "approve" });
  }
  const decision = await service.decidePlan({ planId: plan.planId, actor: "director-sun" });
  return { artifact, wo, plan, decision };
}

export async function seedBatch(service, overrides = {}) {
  return service.registerMaterialBatch({
    batchId: overrides.batchId ?? "batch-0001",
    name: overrides.name ?? "脱酸剂 A",
    materialCode: overrides.materialCode ?? "DA-A",
    quantity: overrides.quantity ?? 10,
    unit: overrides.unit ?? "L",
    expiresAt: overrides.expiresAt ?? "2099-12-31T00:00:00+08:00",
    supplier: overrides.supplier ?? "故宫文保材料厂",
    certificateNo: overrides.certificateNo ?? "CERT-2026-001",
    actor: overrides.actor ?? "keeper-zhou",
  });
}

/** 让服务的时钟固定到某一时刻 */
export function serviceAtFixedTime(service, iso) {
  service.clock = () => new Date(iso);
}
