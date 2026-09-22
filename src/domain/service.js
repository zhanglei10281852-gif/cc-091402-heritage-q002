import crypto from "node:crypto";
import { EventStore } from "./store.js";
import { Projector } from "./projector.js";
import { mintEvent } from "./events.js";
import { DomainError, Errors } from "./errors.js";

const QC_RESULTS = ["pass", "fail", "conditional"];
const EPS = 1e-9;

/**
 * 修复工单领域服务（事件溯源）。
 *
 * 并发模型：每个写命令的【校验 + 事件构造 + 落盘 + 投影】整体放入同一把
 * 串行队列执行。多个修复师同时领取同一批次时，库存校验永远基于上一条领料
 * 已落盘后的最新投影，杜绝超卖与用量漂移。
 */
export class RestorationService {
  constructor({ store, clock = () => new Date(), idGenerator = () => crypto.randomUUID() } = {}) {
    if (!store) throw new Error("RestorationService 需要事件存储");
    this.store = store;
    this.clock = clock;
    this.newId = idGenerator;
    this.projection = new Projector();
    this.queue = Promise.resolve();
  }

  async init() {
    await this.store.load();
    for (const event of this.store.all()) this.projection.apply(event);
    await this.store.open();
  }

  // ---------------------------------------------------------------
  // 命令执行框架
  // ---------------------------------------------------------------

  #enqueue(job) {
    const run = this.queue.then(job, job);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * 在串行队列内执行一个写事务。
   * build() 在锁内同步执行：先做全部校验，再返回
   *   { type, artifactId?, payload?, result? }
   * 或它们的数组（一个事务追加多条事件）。
   */
  #transact(actor, build) {
    if (!actor || typeof actor !== "string") {
      return Promise.reject(new DomainError("actor_required", "缺少经办身份 actor"));
    }
    return this.#enqueue(async () => {
      const emitted = [];
      let result = null;
      let prev = this.store.tail;
      const emit = (spec) => {
        const event = mintEvent(
          {
            type: spec.type,
            at: this.clock().toISOString(),
            actor,
            artifactId: spec.artifactId ?? null,
            payload: spec.payload ?? {},
          },
          prev,
        );
        prev = event.hash;
        emitted.push(event);
        return event;
      };
      const outcome = build(emit);
      // build 也可以直接返回事件规格（或数组），统一转成事件落盘
      if (outcome) {
        const specs = Array.isArray(outcome) ? outcome : [outcome];
        for (const spec of specs) {
          if (spec && typeof spec === "object" && spec.type) {
            if (spec.result !== undefined) result = spec.result;
            emit(spec);
          }
        }
      }
      // 所有事件构造完成后（中途校验失败则一条都不落盘），顺序落盘与投影
      for (const event of emitted) {
        await this.store.append(event);
        this.projection.apply(event);
      }
      return { events: emitted, result };
    });
  }

  // ---------------------------------------------------------------
  // 文物与工单
  // ---------------------------------------------------------------

  async registerArtifact(input) {
    const body = this.#requireObject(input);
    const { events } = await this.#transact(body.actor, (emit) => {
      const artifactId = body.artifactId ?? `artifact-${this.newId().slice(0, 8)}`;
      this.#assertId(artifactId, "artifactId");
      const name = this.#nonEmpty(body.name, "文物名称 name");
      if (this.projection.artifacts.has(artifactId)) {
        throw Errors.conflict("artifact_exists", `文物已存在：${artifactId}`);
      }
      emit({
        type: "artifact_registered",
        artifactId,
        payload: {
          name,
          accessionNo: body.accessionNo ?? null,
          initialCondition: body.initialCondition ?? null,
          measurements: this.#normalizeMeasurements(body.measurements),
        },
      });
      return { artifactId };
    });
    return { artifactId: events[0].artifactId, eventId: events[0].id };
  }

  async createWorkOrder(input) {
    const body = this.#requireObject(input);
    const { events } = await this.#transact(body.actor, () => {
      const artifactId = this.#existingArtifact(body.artifactId);
      const workOrderId = body.workOrderId ?? `wo-${this.newId().slice(0, 8)}`;
      this.#assertId(workOrderId, "workOrderId");
      if (this.projection.workOrders.has(workOrderId)) {
        throw Errors.conflict("work_order_exists", `工单已存在：${workOrderId}`);
      }
      return [
        {
          type: "work_order_created",
          artifactId,
          payload: {
            workOrderId,
            title: this.#nonEmpty(body.title, "工单标题 title"),
            description: body.description ?? null,
          },
        },
      ];
    });
    const workOrderId = events[0].payload.workOrderId;
    return { workOrderId, eventId: events[0].id };
  }

  // ---------------------------------------------------------------
  // 方案草拟 / 修订（每次变更强制绑定风险说明）
  // ---------------------------------------------------------------

  async draftPlan(input) {
    const body = this.#requireObject(input);
    const { events, result } = await this.#transact(body.actor, () => {
      const wo = this.#existingWorkOrder(body.workOrderId);
      const phases = this.#normalizePhases(body.phases);
      const materials = this.#normalizePlanMaterials(body.materials);
      const changeSummary = this.#nonEmpty(body.changeSummary, "方案变更说明 changeSummary");
      // 风险说明是强制结构化字段，不允许用空白文本绕过会签
      const riskNote = this.#normalizeRiskNote(body.riskNote);

      let supersedesPlanId = body.supersedesPlanId ?? null;
      if (supersedesPlanId === null) {
        // 默认修订该工单“最新一版”方案（含在审/被驳回版本），
        // 不能只看 currentPlanId，否则在审方案会被静默绕过。
        const latestEntry = wo.planHistory[wo.planHistory.length - 1] ?? null;
        supersedesPlanId = latestEntry?.planId ?? null;
      }
      if (supersedesPlanId !== null) {
        const previous = this.projection.plans.get(supersedesPlanId);
        if (!previous) throw Errors.notFound("方案", supersedesPlanId);
        if (previous.workOrderId !== wo.workOrderId) {
          throw Errors.unprocessable("plan_cross_work_order", "修订方案必须属于同一工单");
        }
        if (previous.status === "draft" || previous.status === "submitted") {
          throw Errors.conflict(
            "prior_plan_not_decided",
            `上一版方案 ${previous.planId} 尚未经专家会签决定，不能另起修订稿`,
          );
        }
      }

      const version = wo.planHistory.length + 1;
      const planId = body.planId ?? `plan-${this.newId().slice(0, 8)}`;
      this.#assertId(planId, "planId");
      if (this.projection.plans.has(planId)) {
        throw Errors.conflict("plan_exists", `方案已存在：${planId}`);
      }
      return {
        type: "plan_draft_created",
        artifactId: wo.artifactId,
        payload: {
          workOrderId: wo.workOrderId,
          planId,
          version,
          changeSummary,
          riskNote,
          supersedesPlanId,
          phases,
          materials,
          measurements: this.#normalizeMeasurements(body.measurements),
        },
        result: { planId, version, supersedesPlanId },
      };
    });
    return { ...result, eventId: events[0].id };
  }

  async submitPlan(input) {
    const body = this.#requireObject(input);
    const { events } = await this.#transact(body.actor, () => {
      const plan = this.#existingPlan(body.planId);
      if (plan.status !== "draft") {
        throw Errors.conflict("plan_not_draft", `方案当前状态 ${plan.status}，不能送审`);
      }
      return {
        type: "plan_submitted",
        artifactId: this.#woOf(plan).artifactId,
        payload: { planId: plan.planId },
      };
    });
    return { planId: events[0].payload.planId, status: "submitted", eventId: events[0].id };
  }

  /** 专家会签：同一专家只能留痕一次；decision=approve|reject */
  async countersign(input) {
    const body = this.#requireObject(input);
    const { events, result } = await this.#transact(body.actor, () => {
      const plan = this.#existingPlan(body.planId);
      if (plan.status !== "submitted") {
        throw Errors.conflict("plan_not_submitted", `方案当前状态 ${plan.status}，不会签`);
      }
      const decision =
        body.decision === "approve" ? "approve" : body.decision === "reject" ? "reject" : null;
      if (!decision) throw Errors.unprocessable("bad_decision", "decision 必须为 approve 或 reject");
      const expertId = this.#nonEmpty(body.actor, "专家身份 actor");
      if (plan.approvals.some((item) => item.expertId === expertId)) {
        throw Errors.conflict("already_countersigned", `专家 ${expertId} 已会签，不能重复签署`);
      }
      const requiredExperts = this.#requiredExperts(plan);
      return {
        type: "expert_countersigned",
        artifactId: this.#woOf(plan).artifactId,
        payload: {
          planId: plan.planId,
          decision,
          role: body.role ?? "修复专家",
          comment: body.comment ?? null,
        },
        result: { planId: plan.planId, requiredExperts },
      };
    });
    const planId = result.planId;
    const requiredExperts = result.requiredExperts;
    const refreshed = this.projection.plans.get(planId);
    const approvals = refreshed.approvals.filter((item) => item.decision === "approve").length;
    const rejected = refreshed.approvals.some((item) => item.decision === "reject");
    return {
      planId,
      approvals,
      requiredExperts,
      decided: rejected || approvals >= requiredExperts,
      eventId: events[0].id,
    };
  }

  /**
   * 会签落锤：任一 reject -> 驳回；approve 数达标 -> 批准并衔接工序：
   * - 已开工/已完工/已跳过的旧工序实例保持原样（不能静默改写），挂接到新方案；
   * - 未开工的旧工序冻结，冻结原因绑定本次方案变更，指向接替实例；
   * - 新方案新增工序生成待办实例。
   */
  async decidePlan(input) {
    const body = this.#requireObject(input);
    const { events } = await this.#transact(body.actor, (emit) => {
      const plan = this.#existingPlan(body.planId);
      if (plan.status !== "submitted") {
        throw Errors.conflict("plan_not_submitted", `方案当前状态 ${plan.status}，不能决定`);
      }
      const wo = this.#woOf(plan);
      const rejects = plan.approvals.filter((item) => item.decision === "reject");
      const requiredExperts = this.#requiredExperts(plan);
      const approvals = plan.approvals.filter((item) => item.decision === "approve");

      if (rejects.length > 0) {
        emit({
          type: "plan_rejected",
          artifactId: wo.artifactId,
          payload: { planId: plan.planId, reason: rejects[0].comment ?? "专家驳回" },
        });
        return;
      }
      if (approvals.length < requiredExperts) {
        throw Errors.conflict(
          "countersigns_insufficient",
          `会签人数不足：${approvals.length}/${requiredExperts}`,
        );
      }

      // 计算旧版本实例的衔接方式
      const carriedOver = [];
      const toFreeze = [];
      if (plan.supersedesPlanId) {
        const previous = this.projection.plans.get(plan.supersedesPlanId);
        const newByCode = new Map(plan.phases.map((phase) => [phase.code, phase]));
        const latestByCode = this.#latestInstancesByCode(previous);
        for (const [code, oldInst] of latestByCode) {
          if (oldInst.status === "done" || oldInst.status === "skipped" || oldInst.status === "active") {
            // 已开始的工序不能被静默改写：沿用旧实例继续施工/记录
            carriedOver.push({ code, instanceId: oldInst.instanceId, status: oldInst.status });
          } else if (oldInst.status === "pending") {
            // 未开工：冻结；新方案保留该编码则有接替实例，删除该编码则仅冻结留痕
            toFreeze.push({ old: oldInst, phase: newByCode.get(code) ?? null });
          }
          // 已冻结的历史实例忽略
        }
      }

      emit({
        type: "plan_approved",
        artifactId: wo.artifactId,
        payload: { planId: plan.planId, requiredExperts, carriedOver },
      });

      // 已沿用编码不再重复生成实例
      const carriedCodes = new Set(carriedOver.map((item) => item.code));
      const instances = plan.phases
        .filter((phase) => !carriedCodes.has(phase.code))
        .map((phase, index) => ({
          instanceId: `inst-${this.newId().slice(0, 10)}`,
          code: phase.code,
          name: phase.name,
          dependsOn: phase.dependsOn,
          instructions: phase.instructions ?? "",
          order: index,
        }));
      emit({
        type: "phase_instances_spawned",
        artifactId: wo.artifactId,
        payload: {
          workOrderId: wo.workOrderId,
          planId: plan.planId,
          instances,
          linkedInstanceIds: carriedOver.map((item) => item.instanceId),
        },
      });

      const replacementByCode = new Map(instances.map((inst) => [inst.code, inst.instanceId]));
      for (const item of toFreeze) {
        emit({
          type: "phase_superseded",
          artifactId: wo.artifactId,
          payload: {
            workOrderId: wo.workOrderId,
            instanceId: item.old.instanceId,
            newPlanId: plan.planId,
            supersededByInstanceId: item.phase ? replacementByCode.get(item.phase.code) : null,
            reason: `方案 v${plan.version} 生效：${plan.changeSummary}；风险：${plan.riskNote.summary}`,
          },
        });
      }
    });

    const planId = events[0].payload.planId;
    if (events[0].type === "plan_rejected") {
      return { planId, status: "rejected", eventId: events[0].id };
    }
    const spawnEvent = events.find((event) => event.type === "phase_instances_spawned");
    const freezeEvents = events.filter((event) => event.type === "phase_superseded");
    const approve = events.find((event) => event.type === "plan_approved");
    return {
      planId,
      status: "approved",
      carriedOver: approve.payload.carriedOver,
      frozen: freezeEvents.map((event) => event.payload.instanceId),
      spawned: spawnEvent.payload.instances.map((inst) => inst.instanceId),
      eventIds: events.map((event) => event.id),
    };
  }

  // ---------------------------------------------------------------
  // 分阶段施工
  // ---------------------------------------------------------------

  async startPhase(input) {
    const body = this.#requireObject(input);
    const { events } = await this.#transact(body.actor, () => {
      const inst = this.#existingInstance(body.instanceId);
      if (inst.status !== "pending") {
        throw Errors.conflict("phase_not_pending", `工序当前状态 ${inst.status}，不能开工`);
      }
      const blocking = this.#blockingDependencies(inst);
      if (blocking.length > 0) {
        throw Errors.conflict("dependencies_unmet", `前置工序未完工：${blocking.join(", ")}`, {
          blocking,
        });
      }
      return {
        type: "phase_started",
        artifactId: this.#woOf(inst).artifactId,
        payload: { instanceId: inst.instanceId },
      };
    });
    return {
      instanceId: events[0].payload.instanceId,
      status: "active",
      startedAt: events[0].at,
      eventId: events[0].id,
    };
  }

  async completePhase(input) {
    const body = this.#requireObject(input);
    const { events } = await this.#transact(body.actor, () => {
      const inst = this.#existingInstance(body.instanceId);
      if (inst.status !== "active") {
        throw Errors.conflict("phase_not_active", `工序当前状态 ${inst.status}，不能完工`);
      }
      return {
        type: "phase_completed",
        artifactId: this.#woOf(inst).artifactId,
        payload: {
          instanceId: inst.instanceId,
          result: body.result ?? null,
          measurements: this.#normalizeMeasurements(body.measurements),
        },
      };
    });
    return {
      instanceId: events[0].payload.instanceId,
      status: "done",
      completedAt: events[0].at,
      eventId: events[0].id,
    };
  }

  async skipPhase(input) {
    const body = this.#requireObject(input);
    const { events } = await this.#transact(body.actor, () => {
      const inst = this.#existingInstance(body.instanceId);
      if (inst.status === "done" || inst.status === "active") {
        throw Errors.conflict("phase_started_no_skip", "已开始的工序不能跳过（如需整改请走返工）");
      }
      const reason = this.#nonEmpty(body.reason, "跳过原因 reason");
      return {
        type: "phase_skipped",
        artifactId: this.#woOf(inst).artifactId,
        payload: { instanceId: inst.instanceId, reason },
      };
    });
    return { instanceId: events[0].payload.instanceId, status: "skipped", eventId: events[0].id };
  }

  // ---------------------------------------------------------------
  // 返工：生成新工序实例，原记录保留不覆盖
  // ---------------------------------------------------------------

  async openRework(input) {
    const body = this.#requireObject(input);
    const { events, result } = await this.#transact(body.actor, () => {
      const origin = this.#existingInstance(body.instanceId ?? body.originInstanceId);
      if (origin.status !== "done" && origin.status !== "skipped") {
        throw Errors.conflict(
          "rework_target_invalid",
          `工序当前状态 ${origin.status}，只有已完工/已跳过工序可返工`,
        );
      }
      const reason = this.#nonEmpty(body.reason, "返工原因 reason");
      const newInstanceId = `inst-${this.newId().slice(0, 10)}`;
      return {
        type: "rework_opened",
        artifactId: this.#woOf(origin).artifactId,
        payload: {
          originInstanceId: origin.instanceId,
          newInstanceId,
          reason,
          code: body.code ?? origin.code,
          name: body.name ?? origin.name,
          dependsOn: Array.isArray(body.dependsOn) ? body.dependsOn : origin.dependsOn,
          instructions: body.instructions ?? origin.instructions,
        },
        result: { originInstanceId: origin.instanceId, newInstanceId },
      };
    });
    return { ...result, status: "pending", eventId: events[0].id };
  }

  // ---------------------------------------------------------------
  // 材料批次与领用
  // ---------------------------------------------------------------

  async registerMaterialBatch(input) {
    const body = this.#requireObject(input);
    const { events, result } = await this.#transact(body.actor, () => {
      const batchId = body.batchId ?? `batch-${this.newId().slice(0, 8)}`;
      this.#assertId(batchId, "batchId");
      if (this.projection.materialBatches.has(batchId)) {
        throw Errors.conflict("batch_exists", `批次已存在：${batchId}`);
      }
      const quantity = this.#positiveNumber(body.quantity, "库存数量 quantity");
      const expiresAt = this.#isoDate(body.expiresAt, "有效期 expiresAt");
      const supplier = this.#nonEmpty(body.supplier, "供应商 supplier（来源不明材料不得入库）");
      return {
        type: "material_batch_registered",
        payload: {
          batchId,
          materialCode: body.materialCode ?? null,
          name: this.#nonEmpty(body.name, "材料名称 name"),
          quantity,
          unit: this.#nonEmpty(body.unit, "计量单位 unit"),
          expiresAt,
          supplier,
          certificateNo: body.certificateNo ?? null,
        },
        result: { batchId },
      };
    });
    return { ...result, eventId: events[0].id };
  }

  /**
   * 领用材料。硬性拦截（全部在串行锁内校验）：
   * 1) 批次存在且在库、余额充足；2) 未过期；3) 供应商与质检证书齐全；
   * 4) 工序存在且处于可施工状态。
   * 事件内保存批次快照，日后可追溯领用当时的有效期与来源。
   */
  async requisitionMaterial(input) {
    const body = this.#requireObject(input);
    const { events, result } = await this.#transact(body.actor, () => {
      const inst = this.#existingInstance(body.instanceId);
      if (inst.status === "frozen" || inst.status === "skipped") {
        throw Errors.conflict("instance_not_workable", `工序 ${inst.status}，不能领料`);
      }
      if (inst.status === "done") {
        throw Errors.conflict("instance_closed", "工序已完工，如需再次领料请先开返工");
      }
      const batch = this.projection.materialBatches.get(body.batchId);
      if (!batch) throw Errors.notFound("材料批次", body.batchId);
      const now = this.clock();
      if (new Date(batch.expiresAt).getTime() < now.getTime()) {
        throw Errors.unprocessable(
          "batch_expired",
          `批次 ${batch.batchId} 已于 ${batch.expiresAt} 过期，禁止领用`,
          { expiresAt: batch.expiresAt, now: now.toISOString() },
        );
      }
      if (!batch.supplier || !batch.certificateNo) {
        throw Errors.unprocessable(
          "batch_origin_unknown",
          `批次 ${batch.batchId} 缺少供应商或质检证书，来源不明禁止领用`,
        );
      }
      const quantity = this.#positiveNumber(body.quantity, "领用数量 quantity");
      // 耗尽批次（含并发竞争后余额为 0）统一报库存不足
      if (batch.status !== "available" || batch.remainingQuantity + EPS < quantity) {
        throw Errors.conflict(
          "insufficient_stock",
          `库存不足：剩余 ${batch.remainingQuantity}${batch.unit}，申请 ${quantity}${batch.unit}`,
          { remaining: batch.remainingQuantity, requested: quantity },
        );
      }
      const remainingAfter = Math.max(0, batch.remainingQuantity - quantity);
      const requisitionId = `req-${this.newId().slice(0, 10)}`;
      return {
        type: "materials_requisitioned",
        artifactId: this.#woOf(inst).artifactId,
        payload: {
          requisitionId,
          instanceId: inst.instanceId,
          batchId: batch.batchId,
          quantity,
          purpose: body.purpose ?? null,
          snapshot: {
            name: batch.name,
            materialCode: batch.materialCode,
            unit: batch.unit,
            expiresAt: batch.expiresAt,
            supplier: batch.supplier,
            certificateNo: batch.certificateNo,
          },
        },
        result: { requisitionId, batchId: batch.batchId, remainingQuantity: remainingAfter },
      };
    });
    return { ...result, eventId: events[0].id };
  }

  async writeOffMaterial(input) {
    const body = this.#requireObject(input);
    const { events, result } = await this.#transact(body.actor, () => {
      const batch = this.projection.materialBatches.get(body.batchId);
      if (!batch) throw Errors.notFound("材料批次", body.batchId);
      if (batch.status !== "available") {
        throw Errors.conflict("batch_unavailable", `批次状态 ${batch.status}`);
      }
      const quantity =
        body.quantity === undefined
          ? batch.remainingQuantity
          : this.#nonNegativeNumber(body.quantity, "核销数量");
      if (quantity > batch.remainingQuantity + EPS) {
        throw Errors.conflict("writeoff_exceeds_stock", "核销数量超出库存");
      }
      return {
        type: "material_batch_written_off",
        payload: {
          batchId: batch.batchId,
          quantity,
          reason: this.#nonEmpty(body.reason, "核销原因 reason"),
        },
        result: { batchId: batch.batchId, remainingQuantity: batch.remainingQuantity - quantity },
      };
    });
    return { ...result, eventId: events[0].id };
  }

  // ---------------------------------------------------------------
  // 质控与验收
  // ---------------------------------------------------------------

  async recordQc(input) {
    const body = this.#requireObject(input);
    const { events, result } = await this.#transact(body.actor, () => {
      const inst = this.#existingInstance(body.instanceId);
      if (!["active", "done"].includes(inst.status)) {
        throw Errors.conflict("qc_phase_not_started", "工序尚未施工，不能记录质控");
      }
      const { result } = body;
      if (!QC_RESULTS.includes(result)) {
        throw Errors.unprocessable("bad_qc_result", `result 必须为 ${QC_RESULTS.join("/")}`);
      }
      const qcId = `qc-${this.newId().slice(0, 10)}`;
      return {
        type: "qc_recorded",
        artifactId: this.#woOf(inst).artifactId,
        payload: {
          qcId,
          instanceId: inst.instanceId,
          stage: this.#nonEmpty(body.stage, "质控阶段 stage（repair_before/repair_after/acceptance）"),
          result,
          findings: body.findings ?? null,
          measurements: this.#normalizeMeasurements(body.measurements),
        },
        result: { qcId },
      };
    });
    return { ...result, result: events[0].payload.result, eventId: events[0].id };
  }

  // ---------------------------------------------------------------
  // 查询：待办 / 工单 / 时间线
  // ---------------------------------------------------------------

  listTodos({ workOrderId } = {}) {
    const todos = [];
    for (const inst of this.projection.phaseInstances.values()) {
      if (workOrderId && inst.workOrderId !== workOrderId) continue;
      if (inst.status !== "pending") continue;
      const blocking = this.#blockingDependencies(inst);
      todos.push({
        instanceId: inst.instanceId,
        workOrderId: inst.workOrderId,
        planId: inst.planId,
        version: inst.version,
        code: inst.code,
        name: inst.name,
        dependsOn: inst.dependsOn,
        ready: blocking.length === 0,
        blocking,
        originInstanceId: inst.originInstanceId,
        isRework: inst.originInstanceId !== null,
        reworkReason: inst.reworkReason,
      });
    }
    return todos;
  }

  getWorkOrder(workOrderId) {
    const wo = this.#existingWorkOrder(workOrderId);
    const plan = wo.currentPlanId ? this.projection.plans.get(wo.currentPlanId) : null;
    return {
      ...wo,
      currentPlan: plan ? this.#planView(plan) : null,
      instances: wo.phaseInstanceIds.map((id) =>
        this.#instanceView(this.projection.phaseInstances.get(id)),
      ),
    };
  }

  getPlan(planId) {
    return this.#planView(this.#existingPlan(planId));
  }

  getInstance(instanceId) {
    return this.#instanceView(this.#existingInstance(instanceId));
  }

  listBatches() {
    return [...this.projection.materialBatches.values()].map((batch) => ({ ...batch }));
  }

  /** 某件文物的完整修复时间线：跨工单聚合全部事件，含哈希链位置与责任链 */
  getTimeline(artifactId) {
    const artifact = this.projection.artifacts.get(artifactId);
    if (!artifact) throw Errors.notFound("文物", artifactId);
    const events = this.store
      .all()
      .filter((event) => event.artifactId === artifactId)
      .map((event, index) => this.#timelineEntry(event, index));
    return {
      artifactId,
      name: artifact.name,
      generatedAt: this.clock().toISOString(),
      chainHead: this.store.tail,
      events,
    };
  }

  /** 时间线导出为 CSV（管理员），带 BOM 方便 Excel 打开 */
  exportTimelineCsv(artifactId) {
    const timeline = this.getTimeline(artifactId);
    const header = [
      "seq",
      "at",
      "type",
      "actor",
      "workOrderId",
      "planId",
      "instanceId",
      "summary",
      "eventId",
      "prevHash",
      "hash",
    ];
    const rows = timeline.events.map((entry) => [
      entry.seq,
      entry.at,
      entry.type,
      entry.actor,
      entry.refs.workOrderId ?? "",
      entry.refs.planId ?? "",
      entry.refs.instanceId ?? "",
      entry.summary,
      entry.eventId,
      entry.prev,
      entry.hash,
    ]);
    const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
    return "﻿" + csv;
  }

  #timelineEntry(event, seq) {
    const p = event.payload;
    const refs = {
      workOrderId:
        p.workOrderId ?? this.projection.phaseInstances.get(p.instanceId)?.workOrderId ?? null,
      planId: p.planId ?? null,
      instanceId: p.instanceId ?? null,
      batchId: p.batchId ?? null,
      requisitionId: p.requisitionId ?? null,
      qcId: p.qcId ?? null,
    };
    return {
      seq,
      at: event.at,
      type: event.type,
      actor: event.actor,
      refs,
      summary: summarizeEvent(event),
      payload: event.payload,
      eventId: event.id,
      prev: event.prev,
      hash: event.hash,
    };
  }

  // ---------------------------------------------------------------
  // 内部工具
  // ---------------------------------------------------------------

  #planView(plan) {
    return {
      ...plan,
      requiredExperts: this.#requiredExperts(plan),
      instances: plan.instanceIds.map((id) =>
        this.#instanceView(this.projection.phaseInstances.get(id)),
      ),
    };
  }

  #instanceView(inst) {
    const wo = this.projection.workOrders.get(inst.workOrderId);
    const blocking = inst.status === "pending" ? this.#blockingDependencies(inst) : [];
    return {
      ...inst,
      artifactId: wo.artifactId,
      ready: inst.status === "pending" && blocking.length === 0,
      blocking,
      requisitions: inst.requisitionIds.map((id) => this.projection.requisitions.get(id)),
      qcRecords: inst.qcRecordIds.map((id) => this.projection.qcRecords.get(id)),
    };
  }

  #latestInstancesByCode(plan) {
    const map = new Map();
    for (const id of plan.instanceIds) {
      const inst = this.projection.phaseInstances.get(id);
      const existing = map.get(inst.code);
      if (!existing || inst.spawnedAt > existing.spawnedAt) map.set(inst.code, inst);
    }
    return map;
  }

  #blockingDependencies(inst) {
    const wo = this.projection.workOrders.get(inst.workOrderId);
    const blocking = [];
    for (const depCode of inst.dependsOn) {
      // 以该编码“最新实例”的状态为准：
      // 旧实例已完工但质控不合格并开了返工时，最新实例是返工实例，
      // 下游必须等返工实例了结（done/skipped）才算依赖满足。
      let latest = null;
      for (const id of wo.phaseInstanceIds) {
        const other = this.projection.phaseInstances.get(id);
        if (other.code !== depCode) continue;
        if (!latest || other.spawnedAt > latest.spawnedAt) latest = other;
      }
      if (!latest || (latest.status !== "done" && latest.status !== "skipped")) {
        blocking.push(depCode);
      }
    }
    return blocking;
  }

  #requiredExperts(plan) {
    const fromMaterials = Array.isArray(plan.materials) ? plan.materials.length : 0;
    // 至少 2 名专家；涉及材料越多会签越严格（上限 5）
    return Math.min(5, Math.max(2, fromMaterials));
  }

  #existingArtifact(id) {
    const artifactId = this.#nonEmpty(id, "artifactId");
    if (!this.projection.artifacts.has(artifactId)) throw Errors.notFound("文物", artifactId);
    return artifactId;
  }

  #existingWorkOrder(id) {
    const workOrderId = this.#nonEmpty(id, "workOrderId");
    const wo = this.projection.workOrders.get(workOrderId);
    if (!wo) throw Errors.notFound("工单", workOrderId);
    return wo;
  }

  #existingPlan(id) {
    const planId = this.#nonEmpty(id, "planId");
    const plan = this.projection.plans.get(planId);
    if (!plan) throw Errors.notFound("方案", planId);
    return plan;
  }

  #existingInstance(id) {
    const instanceId = this.#nonEmpty(id, "instanceId");
    const inst = this.projection.phaseInstances.get(instanceId);
    if (!inst) throw Errors.notFound("工序实例", instanceId);
    return inst;
  }

  #woOf(planOrInstance) {
    return this.projection.workOrders.get(planOrInstance.workOrderId);
  }

  #requireObject(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new DomainError("bad_request", "请求体必须是 JSON 对象");
    }
    return input;
  }

  #nonEmpty(value, label) {
    if (typeof value !== "string" || value.trim() === "") {
      throw Errors.unprocessable("invalid_field", `${label} 不能为空`);
    }
    return value.trim();
  }

  #assertId(value, label) {
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
      throw Errors.unprocessable("invalid_id", `${label} 格式不合法：${value}`);
    }
  }

  #positiveNumber(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) {
      throw Errors.unprocessable("invalid_field", `${label} 必须为正数`);
    }
    return number;
  }

  #nonNegativeNumber(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) {
      throw Errors.unprocessable("invalid_field", `${label} 不能为负`);
    }
    return number;
  }

  #isoDate(value, label) {
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
      throw Errors.unprocessable("invalid_field", `${label} 必须是 ISO 8601 时间`);
    }
    return new Date(value).toISOString();
  }

  #normalizeMeasurements(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw Errors.unprocessable("invalid_field", "measurements 必须是数组");
    return value.map((item, index) => {
      if (!item || typeof item !== "object") {
        throw Errors.unprocessable("invalid_field", `measurements[${index}] 必须是对象`);
      }
      return {
        metric: this.#nonEmpty(item.metric, `measurements[${index}].metric`),
        value: this.#positiveNumber(item.value, `measurements[${index}].value`),
        // 检测值允许无量纲指标（如 pH、ΔE），缺省记为空串
        unit: typeof item.unit === "string" ? item.unit.trim() : "",
        stage: item.stage ?? null,
        at: item.at
          ? this.#isoDate(item.at, `measurements[${index}].at`)
          : this.clock().toISOString(),
      };
    });
  }

  #normalizePhases(value) {
    if (!Array.isArray(value) || value.length === 0) {
      throw Errors.unprocessable("invalid_field", "phases 至少包含一道工序");
    }
    const codes = new Set();
    const phases = value.map((phase, index) => {
      if (!phase || typeof phase !== "object") {
        throw Errors.unprocessable("invalid_field", `phases[${index}] 必须是对象`);
      }
      const code = this.#nonEmpty(phase.code, `phases[${index}].code`);
      if (codes.has(code)) throw Errors.unprocessable("duplicate_phase_code", `工序编码重复：${code}`);
      codes.add(code);
      const dependsOn = Array.isArray(phase.dependsOn)
        ? phase.dependsOn.map((dep) => this.#nonEmpty(dep, "依赖工序编码"))
        : [];
      return {
        code,
        name: this.#nonEmpty(phase.name, `phases[${index}].name`),
        dependsOn,
        instructions: typeof phase.instructions === "string" ? phase.instructions : "",
      };
    });
    for (const phase of phases) {
      for (const dep of phase.dependsOn) {
        if (dep === phase.code) {
          throw Errors.unprocessable("self_dependency", `工序 ${phase.code} 不能依赖自身`);
        }
        if (!codes.has(dep)) {
          throw Errors.unprocessable("unknown_dependency", `工序 ${phase.code} 依赖不存在的 ${dep}`);
        }
      }
    }
    // 环检测（DFS）
    const byCode = new Map(phases.map((phase) => [phase.code, phase]));
    const seen = new Map();
    const visit = (code, stack) => {
      if (stack.has(code)) {
        throw Errors.unprocessable(
          "dependency_cycle",
          `工序依赖存在环：${[...stack, code].join(" -> ")}`,
        );
      }
      if (seen.has(code)) return;
      stack.add(code);
      for (const dep of byCode.get(code).dependsOn) visit(dep, stack);
      stack.delete(code);
      seen.set(code, true);
    };
    phases.forEach((phase) => visit(phase.code, new Set()));
    return phases;
  }

  #normalizePlanMaterials(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw Errors.unprocessable("invalid_field", "materials 必须是数组");
    return value.map((item, index) => {
      if (!item || typeof item !== "object") {
        throw Errors.unprocessable("invalid_field", `materials[${index}] 必须是对象`);
      }
      return {
        materialCode: item.materialCode ?? null,
        name: this.#nonEmpty(item.name, `materials[${index}].name`),
        plannedQuantity: this.#positiveNumber(
          item.plannedQuantity ?? 1,
          `materials[${index}].plannedQuantity`,
        ),
        unit: this.#nonEmpty(item.unit, `materials[${index}].unit`),
      };
    });
  }

  #normalizeRiskNote(value) {
    if (!value || typeof value !== "object") {
      throw Errors.unprocessable("risk_note_required", "riskNote 必须是结构化风险说明对象");
    }
    return {
      summary: this.#nonEmpty(value.summary, "riskNote.summary 风险概述"),
      affectedPhases: Array.isArray(value.affectedPhases) ? value.affectedPhases : [],
      mitigations: this.#nonEmpty(value.mitigations, "riskNote.mitigations 风险应对措施"),
      residualRisk: value.residualRisk ?? null,
    };
  }
}

function findPayload(events, type) {
  return events.find((event) => event.type === type)?.payload;
}

/** 人类可读的时间线条目摘要（导出/查询用），不替代结构化 payload */
export function summarizeEvent(event) {
  const p = event.payload;
  switch (event.type) {
    case "artifact_registered":
      return `登记文物「${p.name}」`;
    case "work_order_created":
      return `创建工单 ${p.workOrderId}「${p.title}」`;
    case "plan_draft_created":
      return `草拟方案 v${p.version}：${p.changeSummary}；风险：${p.riskNote.summary}`;
    case "plan_submitted":
      return `方案 ${p.planId} 提交专家会签`;
    case "expert_countersigned":
      return `${event.actor} 会签${p.decision === "approve" ? "同意" : "驳回"}${p.comment ? `：${p.comment}` : ""}`;
    case "plan_approved":
      return `方案 ${p.planId} 批准生效`;
    case "plan_rejected":
      return `方案 ${p.planId} 被驳回：${p.reason}`;
    case "phase_instances_spawned":
      return `生成 ${p.instances.length} 道工序实例`;
    case "phase_superseded":
      return `工序 ${p.instanceId} 冻结：${p.reason}`;
    case "phase_started":
      return `工序 ${p.instanceId} 开工（${event.actor}）`;
    case "phase_completed":
      return `工序 ${p.instanceId} 完工（${event.actor}）`;
    case "phase_skipped":
      return `工序 ${p.instanceId} 跳过：${p.reason}`;
    case "rework_opened":
      return `返工：原工序 ${p.originInstanceId} -> 新实例 ${p.newInstanceId}，原因：${p.reason}`;
    case "material_batch_registered":
      return `材料批次 ${p.batchId}「${p.name}」入库 ${p.quantity}${p.unit}，有效期至 ${p.expiresAt}`;
    case "material_batch_written_off":
      return `批次 ${p.batchId} 核销 ${p.quantity ?? "全部"}：${p.reason}`;
    case "materials_requisitioned":
      return `领用 ${p.snapshot?.name ?? p.batchId} ${p.quantity}（批次 ${p.batchId} -> 工序 ${p.instanceId}，经办人 ${event.actor}）`;
    case "qc_recorded":
      return `质控 ${p.stage} 结果 ${p.result}（工序 ${p.instanceId}）`;
    default:
      return event.type;
  }
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}
