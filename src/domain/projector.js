import { DomainError } from "./errors.js";

/**
 * 内存投影：按日志顺序回放全部事件，重建工单、工序实例、材料批次、
 * 领用与质控视图。服务重启后重新投影即可恢复待办与冻结原因。
 *
 * 投影中再次做关键不变量校验（库存非负、状态迁移合法）：
 * 任何异常都意味着事件日志与业务规则冲突，立即中止而不是带病运行。
 */
export class Projector {
  constructor() {
    this.reset();
  }

  reset() {
    this.artifacts = new Map();
    this.workOrders = new Map();
    this.plans = new Map();
    this.phaseInstances = new Map();
    this.materialBatches = new Map();
    this.requisitions = new Map();
    this.qcRecords = new Map();
    this.index = 0;
  }

  apply(event) {
    const handler = this[Projector.eventHandlers[event.type]];
    if (typeof handler !== "function") {
      throw new DomainError("unknown_event", `未知事件类型：${event.type}`, 500);
    }
    handler.call(this, event);
    this.index += 1;
  }

  static eventHandlers = {
    artifact_registered: "artifactRegistered",
    work_order_created: "workOrderCreated",
    plan_draft_created: "planDraftCreated",
    plan_submitted: "planSubmitted",
    expert_countersigned: "expertCountersigned",
    plan_approved: "planApproved",
    plan_rejected: "planRejected",
    phase_instances_spawned: "phaseInstancesSpawned",
    phase_superseded: "phaseSuperseded",
    phase_started: "phaseStarted",
    phase_completed: "phaseCompleted",
    phase_skipped: "phaseSkipped",
    rework_opened: "reworkOpened",
    material_batch_registered: "materialBatchRegistered",
    material_batch_written_off: "materialBatchWrittenOff",
    materials_requisitioned: "materialsRequisitioned",
    qc_recorded: "qcRecorded",
  };

  artifactRegistered(event) {
    const p = event.payload;
    if (this.artifacts.has(event.artifactId)) {
      throw new DomainError("projection_conflict", "文物重复登记", 500);
    }
    this.artifacts.set(event.artifactId, {
      artifactId: event.artifactId,
      name: p.name,
      accessionNo: p.accessionNo ?? null,
      initialCondition: p.initialCondition ?? null,
      measurements: p.measurements ?? [],
      registeredAt: event.at,
      registeredBy: event.actor,
      workOrderIds: [],
    });
  }

  workOrderCreated(event) {
    const artifact = this.artifacts.get(event.artifactId);
    if (!artifact) throw new DomainError("projection_conflict", "工单指向不存在的文物", 500);
    const p = event.payload;
    if (this.workOrders.has(p.workOrderId)) {
      throw new DomainError("projection_conflict", "工单重复创建", 500);
    }
    const wo = {
      workOrderId: p.workOrderId,
      artifactId: event.artifactId,
      title: p.title,
      description: p.description ?? null,
      createdAt: event.at,
      createdBy: event.actor,
      currentPlanId: null,
      planHistory: [],
      phaseInstanceIds: [],
      frozenRecords: [],
    };
    this.workOrders.set(p.workOrderId, wo);
    artifact.workOrderIds.push(p.workOrderId);
  }

  planDraftCreated(event) {
    const p = event.payload;
    const wo = this.workOrders.get(p.workOrderId);
    if (!wo) throw new DomainError("projection_conflict", "方案指向不存在的工单", 500);
    const plan = {
      planId: p.planId,
      workOrderId: p.workOrderId,
      version: p.version,
      status: "draft",
      changeSummary: p.changeSummary,
      riskNote: p.riskNote,
      supersedesPlanId: p.supersedesPlanId ?? null,
      supersededByPlanId: null,
      phases: p.phases,
      materials: p.materials,
      measurements: p.measurements ?? [],
      createdBy: event.actor,
      createdAt: event.at,
      submittedAt: null,
      submittedBy: null,
      decidedAt: null,
      approvals: [],
      instanceIds: [],
      carriedOver: [],
    };
    this.plans.set(p.planId, plan);
    wo.planHistory.push({
      planId: p.planId,
      version: p.version,
      status: "draft",
      createdAt: event.at,
    });
  }

  planSubmitted(event) {
    const plan = this.#plan(event.payload.planId, event);
    plan.status = "submitted";
    plan.submittedAt = event.at;
    plan.submittedBy = event.actor;
    this.#syncHistory(plan);
  }

  expertCountersigned(event) {
    const p = event.payload;
    const plan = this.#plan(p.planId, event);
    if (plan.status !== "submitted") {
      throw new DomainError("projection_conflict", "只有送审方案可以会签", 500);
    }
    plan.approvals.push({
      expertId: event.actor,
      role: p.role ?? "修复专家",
      decision: p.decision,
      comment: p.comment ?? null,
      at: event.at,
      eventId: event.id,
    });
  }

  planApproved(event) {
    const p = event.payload;
    const plan = this.#plan(p.planId, event);
    plan.status = "approved";
    plan.decidedAt = event.at;
    const wo = this.workOrders.get(plan.workOrderId);
    if (plan.supersedesPlanId) {
      const previous = this.plans.get(plan.supersedesPlanId);
      if (previous) previous.supersededByPlanId = plan.planId;
    }
    wo.currentPlanId = plan.planId;
    this.#syncHistory(plan);
  }

  planRejected(event) {
    const plan = this.#plan(event.payload.planId, event);
    plan.status = "rejected";
    plan.decidedAt = event.at;
    this.#syncHistory(plan);
  }

  phaseInstancesSpawned(event) {
    const p = event.payload;
    const wo = this.workOrders.get(p.workOrderId);
    const plan = this.plans.get(p.planId);
    if (!wo || !plan) throw new DomainError("projection_conflict", "工序实例缺少工单/方案", 500);
    for (const item of p.instances) {
      if (this.phaseInstances.has(item.instanceId)) {
        throw new DomainError("projection_conflict", "工序实例重复生成", 500);
      }
      const inst = {
        instanceId: item.instanceId,
        workOrderId: p.workOrderId,
        planId: p.planId,
        version: plan.version,
        code: item.code,
        name: item.name,
        dependsOn: item.dependsOn,
        instructions: item.instructions ?? "",
        order: item.order,
        status: "pending",
        frozenReason: null,
        supersededByInstanceId: null,
        originInstanceId: null,
        reworkReason: null,
        reworkInstanceIds: [],
        startedAt: null,
        startedBy: null,
        completedAt: null,
        completedBy: null,
        result: null,
        skippedAt: null,
        skippedBy: null,
        skipReason: null,
        requisitionIds: [],
        qcRecordIds: [],
        spawnedAt: event.at,
      };
      this.phaseInstances.set(item.instanceId, inst);
      wo.phaseInstanceIds.push(item.instanceId);
      plan.instanceIds.push(item.instanceId);
    }
    // 已沿用的旧实例（上一版已开工/已了结）挂接到新方案，保持方案视图完整
    for (const linkedId of p.linkedInstanceIds ?? []) {
      const linked = this.phaseInstances.get(linkedId);
      if (!linked) throw new DomainError("projection_conflict", "挂接的工序实例不存在", 500);
      if (!plan.instanceIds.includes(linkedId)) plan.instanceIds.push(linkedId);
    }
  }

  phaseSuperseded(event) {
    const p = event.payload;
    const inst = this.#inst(p.instanceId, event);
    if (inst.status !== "pending") {
      throw new DomainError("projection_conflict", "只有未开工工序可被冻结", 500);
    }
    inst.status = "frozen";
    inst.frozenReason = {
      kind: "plan_superseded",
      note: p.reason,
      newPlanId: p.newPlanId ?? null,
      at: event.at,
      eventId: event.id,
    };
    if (p.supersededByInstanceId) inst.supersededByInstanceId = p.supersededByInstanceId;
    const wo = this.workOrders.get(inst.workOrderId);
    wo.frozenRecords.push({
      instanceId: inst.instanceId,
      code: inst.code,
      name: inst.name,
      reason: p.reason,
      newPlanId: p.newPlanId ?? null,
      supersededByInstanceId: p.supersededByInstanceId ?? null,
      at: event.at,
      by: event.actor,
      eventId: event.id,
    });
  }

  phaseStarted(event) {
    const inst = this.#inst(event.payload.instanceId, event);
    if (inst.status !== "pending") {
      throw new DomainError("projection_conflict", "只有待办工序可以开工", 500);
    }
    inst.status = "active";
    inst.startedAt = event.at;
    inst.startedBy = event.actor;
  }

  phaseCompleted(event) {
    const inst = this.#inst(event.payload.instanceId, event);
    if (inst.status !== "active") {
      throw new DomainError("projection_conflict", "只有施工中工序可以完工", 500);
    }
    inst.status = "done";
    inst.completedAt = event.at;
    inst.completedBy = event.actor;
    inst.result = event.payload.result ?? null;
  }

  phaseSkipped(event) {
    const inst = this.#inst(event.payload.instanceId, event);
    if (inst.status !== "pending" && inst.status !== "frozen") {
      throw new DomainError("projection_conflict", "只有未开工工序可以跳过", 500);
    }
    inst.status = "skipped";
    inst.skippedAt = event.at;
    inst.skippedBy = event.actor;
    inst.skipReason = event.payload.reason;
  }

  reworkOpened(event) {
    const p = event.payload;
    const origin = this.#inst(p.originInstanceId, event);
    if (origin.status !== "done" && origin.status !== "skipped") {
      throw new DomainError("projection_conflict", "返工只能针对已完工/已跳过的工序", 500);
    }
    const wo = this.workOrders.get(origin.workOrderId);
    if (this.phaseInstances.has(p.newInstanceId)) {
      throw new DomainError("projection_conflict", "返工实例重复生成", 500);
    }
    // 原实例保持 done/skipped 不动（保留首次施工与质控记录），仅追加返工链指针。
    const inst = {
      instanceId: p.newInstanceId,
      workOrderId: origin.workOrderId,
      planId: origin.planId,
      version: origin.version,
      code: p.code ?? origin.code,
      name: p.name ?? origin.name,
      dependsOn: p.dependsOn ?? origin.dependsOn,
      instructions: p.instructions ?? origin.instructions,
      order: origin.order,
      status: "pending",
      frozenReason: null,
      supersededByInstanceId: null,
      originInstanceId: origin.instanceId,
      reworkReason: p.reason,
      reworkInstanceIds: [],
      startedAt: null,
      startedBy: null,
      completedAt: null,
      completedBy: null,
      result: null,
      skippedAt: null,
      skippedBy: null,
      skipReason: null,
      requisitionIds: [],
      qcRecordIds: [],
      spawnedAt: event.at,
    };
    this.phaseInstances.set(p.newInstanceId, inst);
    wo.phaseInstanceIds.push(p.newInstanceId);
    origin.reworkInstanceIds.push(p.newInstanceId);
    const plan = this.plans.get(origin.planId);
    plan.instanceIds.push(p.newInstanceId);
  }

  materialBatchRegistered(event) {
    const p = event.payload;
    if (this.materialBatches.has(p.batchId)) {
      throw new DomainError("projection_conflict", "材料批次号重复", 500);
    }
    this.materialBatches.set(p.batchId, {
      batchId: p.batchId,
      materialCode: p.materialCode ?? null,
      name: p.name,
      totalQuantity: p.quantity,
      remainingQuantity: p.quantity,
      unit: p.unit,
      expiresAt: p.expiresAt,
      supplier: p.supplier,
      certificateNo: p.certificateNo ?? null,
      status: "available",
      receivedAt: event.at,
      registeredBy: event.actor,
      requisitionIds: [],
      writeOffs: [],
    });
  }

  materialBatchWrittenOff(event) {
    const p = event.payload;
    const batch = this.materialBatches.get(p.batchId);
    if (!batch || batch.status !== "available") {
      throw new DomainError("projection_conflict", "只能核销在库批次", 500);
    }
    const quantity = p.quantity ?? batch.remainingQuantity;
    if (quantity <= 0 || quantity > batch.remainingQuantity) {
      throw new DomainError("projection_conflict", "核销数量超出库存", 500);
    }
    batch.remainingQuantity -= quantity;
    batch.writeOffs.push({ quantity, reason: p.reason, at: event.at, by: event.actor, eventId: event.id });
    if (batch.remainingQuantity === 0) batch.status = "depleted";
  }

  materialsRequisitioned(event) {
    const p = event.payload;
    const batch = this.materialBatches.get(p.batchId);
    const inst = this.#inst(p.instanceId, event);
    if (!batch) throw new DomainError("projection_conflict", "领用指向不存在的批次", 500);
    if (batch.status !== "available") {
      throw new DomainError("projection_conflict", "批次已不可用", 500);
    }
    if (batch.remainingQuantity + 1e-9 < p.quantity) {
      throw new DomainError("projection_conflict", "库存余额为负，日志不一致", 500);
    }
    batch.remainingQuantity -= p.quantity;
    if (batch.remainingQuantity <= 1e-9) {
      batch.remainingQuantity = 0;
      batch.status = "depleted";
    }
    const req = {
      requisitionId: p.requisitionId,
      workOrderId: inst.workOrderId,
      instanceId: p.instanceId,
      batchId: p.batchId,
      materialCode: batch.materialCode,
      name: batch.name,
      quantity: p.quantity,
      unit: batch.unit,
      purpose: p.purpose ?? null,
      at: event.at,
      by: event.actor,
      eventId: event.id,
      batchSnapshot: p.snapshot,
    };
    this.requisitions.set(p.requisitionId, req);
    batch.requisitionIds.push(p.requisitionId);
    inst.requisitionIds.push(p.requisitionId);
  }

  qcRecorded(event) {
    const p = event.payload;
    const inst = this.#inst(p.instanceId, event);
    const record = {
      qcId: p.qcId,
      workOrderId: inst.workOrderId,
      instanceId: p.instanceId,
      stage: p.stage,
      result: p.result,
      findings: p.findings ?? null,
      measurements: p.measurements ?? [],
      at: event.at,
      by: event.actor,
      eventId: event.id,
    };
    this.qcRecords.set(p.qcId, record);
    inst.qcRecordIds.push(p.qcId);
  }

  // ---- 查询辅助 ----

  #plan(planId, event) {
    const plan = this.plans.get(planId);
    if (!plan) throw new DomainError("projection_conflict", `方案不存在：${planId}（事件 ${event?.id}）`, 500);
    return plan;
  }

  #inst(instanceId, event) {
    const inst = this.phaseInstances.get(instanceId);
    if (!inst) {
      throw new DomainError("projection_conflict", `工序实例不存在：${instanceId}（事件 ${event?.id}）`, 500);
    }
    return inst;
  }

  #syncHistory(plan) {
    const wo = this.workOrders.get(plan.workOrderId);
    const entry = wo.planHistory.find((item) => item.planId === plan.planId);
    if (entry) entry.status = plan.status;
  }

  /** 依赖是否满足：每个依赖编码的“最新实例”已了结（done/skipped） */
  isReady(inst) {
    if (inst.status !== "pending") return false;
    const wo = this.workOrders.get(inst.workOrderId);
    for (const depCode of inst.dependsOn) {
      let latest = null;
      for (const id of wo.phaseInstanceIds) {
        const other = this.phaseInstances.get(id);
        if (other.code !== depCode) continue;
        if (!latest || other.spawnedAt > latest.spawnedAt) latest = other;
      }
      if (!latest || (latest.status !== "done" && latest.status !== "skipped")) return false;
    }
    return true;
  }
}
