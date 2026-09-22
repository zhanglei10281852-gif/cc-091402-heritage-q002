import { newId } from "../lib/ids.js";
import { assert, fail } from "../lib/errors.js";

const PLAN_DRAFT = "draft";
const PLAN_APPROVED = "approved";
const PLAN_SUPERSEDED = "superseded";

/**
 * 修复工单领域服务。
 *
 * 状态完全由事件流派生：启动时重放事件日志重建投影，命令在互斥队列内
 * “校验 -> 追加事件(fsync) -> 更新投影”，因此：
 *  - 多个修复师并发领取同一批材料时，库存扣减与用量统计串行提交，保持一致；
 *  - 进程重启后待办、冻结原因、责任链均可从历史事件恢复查询。
 */
export class RestorationService {
  constructor(store, { now = () => new Date() } = {}) {
    this.store = store;
    this.clock = now;
    this.queue = Promise.resolve();
    this.state = createEmptyState();
  }

  async load() {
    const events = await this.store.readAll();
    for (const event of events) this.apply(event);
  }

  async close() {
    await this.store.close();
  }

  #enqueue(job) {
    const run = this.queue.then(job, job);
    // 让队列不因单个命令失败而断裂
    this.queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  timestamp() {
    return this.clock().toISOString();
  }

  // ---------- 文物与检测值 ----------

  registerArtifact({ id, name, measurements, actor }) {
    return this.#enqueue(async () => {
      assert(typeof name === "string" && name.trim(), 400, "invalid_name", "文物名称不能为空");
      const artifactId = id ?? newId("artifact");
      assert(!this.state.artifacts.has(artifactId), 409, "artifact_exists", "文物已登记", { artifactId });
      if (measurements) validateMeasurements(measurements);
      await this.#record({
        type: "artifact_registered",
        artifactId,
        name: name.trim(),
        measurements: measurements ?? null,
        actor,
      });
      return this.getArtifact(artifactId);
    });
  }

  addMeasurement(artifactId, { stage, values, actor }) {
    return this.#enqueue(async () => {
      const artifact = this.#requireArtifact(artifactId);
      assert(stage === "before" || stage === "after" || stage === "during",
        400, "invalid_stage", "检测阶段必须为 before / during / after");
      validateMeasurements(values);
      await this.#record({
        type: "artifact_measured",
        artifactId: artifact.id,
        measurementId: newId("meas"),
        stage,
        values,
        actor,
      });
      return this.getArtifact(artifactId);
    });
  }

  getArtifact(artifactId) {
    const artifact = this.state.artifacts.get(artifactId);
    assert(artifact, 404, "artifact_not_found", "文物不存在");
    return serializeArtifact(artifact);
  }

  listArtifacts() {
    return [...this.state.artifacts.values()].map(serializeArtifact);
  }

  // ---------- 材料批次 ----------

  registerMaterialLot({ id, name, supplier, sourceEvidence, quantity, unit, expiryDate, actor }) {
    return this.#enqueue(async () => {
      assert(typeof name === "string" && name.trim(), 400, "invalid_name", "材料名称不能为空");
      // 来源不明的材料禁止入库：供应商与溯源凭证缺一不可
      assert(typeof supplier === "string" && supplier.trim(), 400, "source_unknown",
        "材料来源不明：必须提供供应商");
      assert(typeof sourceEvidence === "string" && sourceEvidence.trim(), 400, "source_unknown",
        "材料来源不明：必须提供溯源凭证编号");
      assert(Number.isFinite(quantity) && quantity > 0, 400, "invalid_quantity", "库存数量必须为正数");
      const expiry = parseDate(expiryDate, "expiryDate");
      const lotId = id ?? newId("lot");
      assert(!this.state.lots.has(lotId), 409, "lot_exists", "材料批次已存在", { lotId });
      await this.#record({
        type: "material_lot_registered",
        lotId,
        name: name.trim(),
        supplier: supplier.trim(),
        sourceEvidence: sourceEvidence.trim(),
        quantity,
        unit: unit ?? "份",
        expiryDate: expiry,
        actor,
      });
      return this.getMaterialLot(lotId);
    });
  }

  quarantineMaterialLot(lotId, { reason, actor }) {
    return this.#enqueue(async () => {
      this.#requireLot(lotId);
      assert(typeof reason === "string" && reason.trim(), 400, "invalid_reason", "封存原因不能为空");
      await this.#record({ type: "material_lot_quarantined", lotId, reason: reason.trim(), actor });
      return this.getMaterialLot(lotId);
    });
  }

  getMaterialLot(lotId) {
    return serializeLot(this.#requireLot(lotId), this.state);
  }

  listMaterialLots() {
    return [...this.state.lots.values()].map((lot) => serializeLot(lot, this.state));
  }

  // ---------- 工单与方案 ----------

  createWorkOrder({ id, artifactId, title, actor }) {
    return this.#enqueue(async () => {
      this.#requireArtifact(artifactId);
      assert(typeof title === "string" && title.trim(), 400, "invalid_title", "工单标题不能为空");
      const orderId = id ?? newId("order");
      assert(!this.state.orders.has(orderId), 409, "order_exists", "工单已存在", { orderId });
      await this.#record({ type: "work_order_created", orderId, artifactId, title: title.trim(), actor });
      return this.getWorkOrder(orderId);
    });
  }

  draftPlan(orderId, body) {
    return this.#enqueue(async () => {
      const order = this.#requireOrder(orderId);
      const { content, phases, risks, actor } = body;
      const requiredExperts = body.requiredExperts ?? 2;
      validatePlanContent(content);
      assert(Number.isInteger(requiredExperts) && requiredExperts >= 1 && requiredExperts <= 5,
        400, "invalid_required_experts", "会签专家人数须为 1..5");
      const normalizedPhases = normalizePhases(phases);
      assertDag(normalizedPhases);
      const normalizedRisks = normalizeRisks(risks);

      const current = currentPlan(order);
      const basedOnVersion = body.basedOnVersion ?? (current ? current.version : null);
      if (!current) {
        assert(basedOnVersion == null, 400, "invalid_base_version", "首版方案没有可基于的旧版本");
      } else {
        assert(basedOnVersion === current.version, 409, "version_conflict",
          "方案已被他人更新，请基于最新版本草拟", { currentVersion: current.version });
      }

      const started = [...order.instances.values()].some((op) =>
        op.status !== "pending" && op.status !== "superseded");
      // 已开始的工序不能被静默改写：开工后只允许走返工流程
      assert(!started, 409, "plan_locked",
        "工序已开始，禁止直接改写方案；如需调整请发起返工",
        { startedOperations: [...order.instances.values()].filter((op) =>
          op.status !== "pending" && op.status !== "superseded").map((op) => op.id) });

      if (current) {
        // 每次方案变更必须绑定风险说明，且内容确实发生变化
        assert(normalizedRisks.length > 0, 400, "risk_required",
          "方案变更必须绑定至少一条风险说明");
        assert(planChanged(current, { content, phases: normalizedPhases }), 409, "no_change",
          "新方案与当前版本完全一致，不构成变更");
      }

      const version = order.nextVersion;
      await this.#record({
        type: "plan_drafted",
        orderId,
        artifactId: order.artifactId,
        version,
        basedOnVersion,
        content,
        phases: normalizedPhases,
        risks: normalizedRisks,
        requiredExperts,
        actor,
      });
      return this.getPlan(orderId, version);
    });
  }

  countersignPlan(orderId, version, { actor }) {
    return this.#enqueue(async () => {
      const order = this.#requireOrder(orderId);
      const plan = requirePlanVersion(order, version);
      assert(plan.status === PLAN_DRAFT, 409, "plan_not_draft", "只有草拟中的方案可以会签", { status: plan.status });
      assert(actor.role === "专家", 403, "forbidden", "只有修复专家可以会签方案");
      assert(!plan.countersignatures.has(actor.id), 409, "already_countersigned",
        "同一位专家不能重复会签", { expertId: actor.id });
      assert(plan.countersignatures.size < plan.requiredExperts, 409, "quorum_full", "会签已达法定人数");

      const wasApproved = planQuorum(plan);
      await this.#record({
        type: "plan_countersigned",
        orderId,
        artifactId: order.artifactId,
        version,
        expertId: actor.id,
        actor,
      });
      const nowApproved = planQuorum(plan);
      if (!wasApproved && nowApproved) {
        await this.#record({ type: "plan_approved", orderId, artifactId: order.artifactId, version });
      }
      return this.getPlan(orderId, version);
    });
  }

  getPlan(orderId, version) {
    const order = this.#requireOrder(orderId);
    const plan = requirePlanVersion(order, version);
    return serializePlan(plan, order);
  }

  // ---------- 施工：开工 / 冻结 / 完工 / 质控 ----------

  startOperation(operationId, { actor }) {
    return this.#enqueue(async () => {
      const { order, op } = this.#requireOperation(operationId);
      assert(op.active, 409, "operation_inactive", "该工序实例已被新版本方案取代");
      assert(op.status === "pending", 409, "invalid_status",
        "只有待办工序可以开工", { status: op.status });
      const blocked = dependencyBlockers(order, op);
      assert(blocked.length === 0, 409, "dependencies_unmet",
        "前置工序尚未完成，不能开工", { waitingFor: blocked });

      await this.#record({ type: "operation_started", orderId: order.id, artifactId: order.artifactId, operationId, actor });
      return this.getOperation(operationId);
    });
  }

  freezeOperation(operationId, { reason, actor }) {
    return this.#enqueue(async () => {
      const { order, op } = this.#requireOperation(operationId);
      assert(typeof reason === "string" && reason.trim(), 400, "invalid_reason", "冻结原因不能为空");
      assert(op.status === "in_progress" || op.status === "pending", 409, "invalid_status",
        "只有进行中或待办的工序可以冻结", { status: op.status });
      await this.#record({
        type: "operation_frozen",
        orderId: order.id,
        artifactId: order.artifactId,
        operationId,
        reason: reason.trim(),
        actor,
      });
      return this.getOperation(operationId);
    });
  }

  resumeOperation(operationId, { note, actor }) {
    return this.#enqueue(async () => {
      const { order, op } = this.#requireOperation(operationId);
      assert(op.status === "frozen", 409, "invalid_status", "只有冻结中的工序可以解除冻结", { status: op.status });
      await this.#record({
        type: "operation_resumed",
        orderId: order.id,
        artifactId: order.artifactId,
        operationId,
        note: typeof note === "string" ? note.trim() : "",
        actor,
      });
      return this.getOperation(operationId);
    });
  }

  completeOperation(operationId, { actor }) {
    return this.#enqueue(async () => {
      const { order, op } = this.#requireOperation(operationId);
      assert(op.status === "in_progress", 409, "invalid_status",
        "只有进行中的工序可以完工", { status: op.status });
      await this.#record({ type: "operation_completed", orderId: order.id, artifactId: order.artifactId, operationId, actor });
      return this.getOperation(operationId);
    });
  }

  inspectOperation(operationId, { passed, sample, findings, actor }) {
    return this.#enqueue(async () => {
      const { order, op } = this.#requireOperation(operationId);
      assert(op.status === "completed" || op.status === "accepted" || op.status === "rejected",
        409, "invalid_status", "工序完工后才能提交验收样例", { status: op.status });
      assert(typeof passed === "boolean", 400, "invalid_passed", "passed 必须为布尔值");
      if (sample) validateSample(sample);
      const inspectionId = newId("qc");
      await this.#record({
        type: "operation_inspected",
        orderId: order.id,
        artifactId: order.artifactId,
        operationId,
        inspectionId,
        passed,
        sample: sample ?? null,
        findings: typeof findings === "string" ? findings.trim() : "",
        actor,
      });
      return this.getOperation(operationId);
    });
  }

  getOperation(operationId) {
    return serializeOperation(this.#requireOperation(operationId).op);
  }

  // ---------- 返工 ----------

  requestRework(operationId, { reason, change, risks, actor, requiredExperts }) {
    return this.#enqueue(async () => {
      const { order, op } = this.#requireOperation(operationId);
      assert(op.status === "rejected" || op.status === "completed" || op.status === "accepted",
        409, "invalid_status", "只有完工或已验收的工序可以返工", { status: op.status });
      assert(typeof reason === "string" && reason.trim(), 400, "invalid_reason", "返工原因不能为空");
      const normalizedRisks = normalizeRisks(risks);
      assert(normalizedRisks.length > 0, 400, "risk_required",
        "返工属于方案变更，必须绑定至少一条风险说明");
      if (change) validatePlanContent(change);
      const quorum = requiredExperts ?? 2;
      assert(Number.isInteger(quorum) && quorum >= 1 && quorum <= 5,
        400, "invalid_required_experts", "会签专家人数须为 1..5");

      const reworkId = newId("rw");
      await this.#record({
        type: "rework_requested",
        reworkId,
        orderId: order.id,
        artifactId: order.artifactId,
        sourceOperationId: operationId,
        generation: op.generation,
        reason: reason.trim(),
        change: change ?? null,
        risks: normalizedRisks,
        requiredExperts: quorum,
        actor,
      });
      return this.getRework(reworkId);
    });
  }

  countersignRework(reworkId, { actor }) {
    return this.#enqueue(async () => {
      const rework = this.#requireRework(reworkId);
      assert(rework.status === "awaiting_countersign", 409, "rework_not_open",
        "返工申请不在待会签状态", { status: rework.status });
      assert(actor.role === "专家", 403, "forbidden", "只有修复专家可以会签返工方案");
      assert(!rework.countersignatures.has(actor.id), 409, "already_countersigned",
        "同一位专家不能重复会签", { expertId: actor.id });

      const willApprove = rework.countersignatures.size + 1 >= rework.requiredExperts;
      await this.#record({
        type: "rework_countersigned",
        reworkId,
        orderId: rework.orderId,
        artifactId: rework.artifactId,
        expertId: actor.id,
        actor,
      });
      if (willApprove) {
        const order = this.#requireOrder(rework.orderId);
        const source = order.instances.get(rework.sourceOperationId);
        const newOperationId = `op_${reworkId}`;
        await this.#record({
          type: "rework_approved",
          reworkId,
          orderId: order.id,
          artifactId: order.artifactId,
          newOperationId,
        });
        await this.#record({
          type: "operation_created",
          orderId: order.id,
          artifactId: order.artifactId,
          operationId: newOperationId,
          phaseId: source.phaseId,
          name: source.name,
          dependsOn: source.dependsOn,
          planVersion: source.planVersion,
          generation: source.generation + 1,
          reworkOf: source.id,
          reworkId,
        });
      }
      return this.getRework(reworkId);
    });
  }

  getRework(reworkId) {
    return serializeRework(this.#requireRework(reworkId));
  }

  // ---------- 材料领用与用量 ----------

  claimMaterial({ orderId, operationId, lotId, quantity, actor }) {
    return this.#enqueue(async () => {
      const order = this.#requireOrder(orderId);
      assert(Number.isFinite(quantity) && quantity > 0, 400, "invalid_quantity", "领用数量必须为正数");
      const lot = this.#requireLot(lotId);
      if (operationId) {
        const op = order.instances.get(operationId);
        assert(op, 404, "operation_not_found", "工序不存在");
        assert(op.active, 409, "operation_inactive", "不能向已作废的工序实例领料");
      }
      // 过期材料阻止领用（按当天日期比较）
      const today = this.clock().toISOString().slice(0, 10);
      assert(lot.expiryDate >= today, 409, "material_expired",
        "材料已过有效期，禁止领用", { expiryDate: lot.expiryDate, today });
      // 来源不明 / 已封存材料阻止领用
      assert(!lot.quarantine, 409, "material_quarantined",
        "材料批次已被封存，禁止领用", { quarantine: lot.quarantine });
      const reserved = this.#lotReserved(lotId);
      assert(lot.quantity - reserved >= quantity, 409, "insufficient_stock",
        "可用库存不足", { lotQuantity: lot.quantity, reserved, requested: quantity, available: lot.quantity - reserved });

      const claimId = newId("claim");
      await this.#record({
        type: "material_claimed",
        claimId,
        orderId,
        artifactId: order.artifactId,
        operationId: operationId ?? null,
        lotId,
        quantity,
        unit: lot.unit,
        actor,
      });
      return this.getClaim(claimId);
    });
  }

  recordUsage(claimId, { quantity, actor }) {
    return this.#enqueue(async () => {
      const claim = this.#requireClaim(claimId);
      assert(Number.isFinite(quantity) && quantity > 0, 400, "invalid_quantity", "用量必须为正数");
      assert(claim.usedQuantity + quantity <= claim.quantity + 1e-9, 409, "usage_exceeds_claim",
        "实际用量不能超过领用量", { claimed: claim.quantity, used: claim.usedQuantity, requested: quantity });
      const usageId = newId("use");
      await this.#record({
        type: "material_used",
        usageId,
        claimId,
        orderId: claim.orderId,
        artifactId: claim.artifactId,
        lotId: claim.lotId,
        operationId: claim.operationId,
        quantity,
        actor,
      });
      return this.getClaim(claimId);
    });
  }

  getClaim(claimId) {
    return serializeClaim(this.#requireClaim(claimId));
  }

  // ---------- 查询 ----------

  getWorkOrder(orderId) {
    const order = this.#requireOrder(orderId);
    return serializeOrder(order, this.state);
  }

  listWorkOrders() {
    return [...this.state.orders.values()].map((order) => serializeOrder(order, this.state));
  }

  listTodos(actorId = null) {
    const todos = [];
    for (const order of this.state.orders.values()) {
      for (const op of order.instances.values()) {
        if (!op.active) continue;
        if (op.status === "pending" || op.status === "in_progress" || op.status === "frozen" || op.status === "rejected") {
          todos.push(serializeTodo(order, op));
        }
      }
    }
    if (actorId) return todos.filter((todo) => todo.assignedTo == null || todo.assignedTo === actorId);
    return todos;
  }

  // 管理员导出：某件文物的完整修复时间线与责任链
  getTimeline(artifactId) {
    const artifact = this.state.artifacts.get(artifactId);
    assert(artifact, 404, "artifact_not_found", "文物不存在");
    const events = this.state.events
      .filter((event) => event.artifactId === artifactId)
      .map((event) => ({
        seq: event.seq,
        at: event.at,
        type: event.type,
        actor: event.actor ? { id: event.actor.id, role: event.actor.role } : null,
        data: timelineData(event),
      }));

    const chain = new Map();
    for (const event of this.state.events.filter((e) => e.artifactId === artifactId && e.actor)) {
      const entry = chain.get(event.actor.id) ?? { actor: { id: event.actor.id, role: event.actor.role }, actions: [] };
      entry.actions.push({ seq: event.seq, at: event.at, type: event.type });
      chain.set(event.actor.id, entry);
    }

    const orders = [...this.state.orders.values()]
      .filter((order) => order.artifactId === artifactId)
      .map((order) => serializeOrder(order, this.state));

    return {
      artifact: serializeArtifact(artifact),
      exportedAt: this.timestamp(),
      events,
      orders,
      responsibilityChain: [...chain.values()],
    };
  }

  // ---------- 内部：事件记录与投影 ----------

  async #record(data) {
    const event = {
      seq: this.state.nextSeq,
      at: this.timestamp(),
      ...data,
    };
    await this.store.append(event);
    this.apply(event);
    return event;
  }

  apply(event) {
    const state = this.state;
    if (event.seq >= state.nextSeq) state.nextSeq = event.seq + 1;
    state.events.push(event);

    switch (event.type) {
      case "artifact_registered": {
        state.artifacts.set(event.artifactId, {
          id: event.artifactId,
          name: event.name,
          measurements: event.measurements
            ? [{ measurementId: null, stage: "before", values: event.measurements, by: event.actor?.id ?? null, at: event.at }]
            : [],
          createdAt: event.at,
        });
        break;
      }
      case "artifact_measured": {
        const artifact = state.artifacts.get(event.artifactId);
        artifact.measurements.push({
          measurementId: event.measurementId,
          stage: event.stage,
          values: event.values,
          by: event.actor?.id ?? null,
          at: event.at,
        });
        break;
      }
      case "material_lot_registered": {
        state.lots.set(event.lotId, {
          id: event.lotId,
          name: event.name,
          supplier: event.supplier,
          sourceEvidence: event.sourceEvidence,
          quantity: event.quantity,
          unit: event.unit,
          expiryDate: event.expiryDate,
          quarantine: null,
          createdAt: event.at,
        });
        break;
      }
      case "material_lot_quarantined": {
        state.lots.get(event.lotId).quarantine = { reason: event.reason, by: event.actor?.id ?? null, at: event.at };
        break;
      }
      case "work_order_created": {
        state.orders.set(event.orderId, {
          id: event.orderId,
          artifactId: event.artifactId,
          title: event.title,
          createdAt: event.at,
          createdBy: event.actor?.id ?? null,
          nextVersion: 1,
          plans: new Map(),
          instances: new Map(),
          instanceOrder: [],
        });
        break;
      }
      case "plan_drafted": {
        const order = state.orders.get(event.orderId);
        const plan = {
          version: event.version,
          basedOnVersion: event.basedOnVersion,
          status: PLAN_DRAFT,
          content: event.content,
          phases: event.phases,
          risks: event.risks,
          requiredExperts: event.requiredExperts,
          countersignatures: new Map(),
          draftedBy: event.actor?.id ?? null,
          createdAt: event.at,
          approvedAt: null,
        };
        order.plans.set(event.version, plan);
        order.nextVersion = event.version + 1;
        break;
      }
      case "plan_countersigned": {
        const plan = state.orders.get(event.orderId).plans.get(event.version);
        plan.countersignatures.set(event.expertId, { expertId: event.expertId, at: event.at });
        break;
      }
      case "plan_approved": {
        const order = state.orders.get(event.orderId);
        const plan = order.plans.get(event.version);
        plan.status = PLAN_APPROVED;
        plan.approvedAt = event.at;
        // 旧版未开工的待办实例被新版本取代（已开始/已完成的实例绝不动）
        for (const old of order.instances.values()) {
          if (old.active && old.status === "pending" && old.planVersion !== event.version) {
            old.status = "superseded";
            old.active = false;
            old.supersededBy = `plan:v${event.version}`;
          }
        }
        // 确定性生成该版本的工序实例，崩溃重放也能得到同样结果
        for (const phase of plan.phases) {
          const operationId = `op_${order.id}_v${event.version}_${phase.id}`;
          if (!order.instances.has(operationId)) {
            materializeInstance(order, {
              operationId,
              phaseId: phase.id,
              name: phase.name,
              dependsOn: phase.dependsOn,
              planVersion: event.version,
              generation: 1,
            }, event.at);
          }
        }
        break;
      }
      case "operation_created": {
        const order = state.orders.get(event.orderId);
        if (!order.instances.has(event.operationId)) {
          materializeInstance(order, {
            operationId: event.operationId,
            phaseId: event.phaseId,
            name: event.name,
            dependsOn: event.dependsOn,
            planVersion: event.planVersion,
            generation: event.generation,
            reworkOf: event.reworkOf ?? null,
            reworkId: event.reworkId ?? null,
          }, event.at);
        }
        break;
      }
      case "operation_started": {
        const op = state.orders.get(event.orderId).instances.get(event.operationId);
        op.status = "in_progress";
        op.startedAt = event.at;
        op.startedBy = event.actor?.id ?? null;
        op.events.push({ type: "started", at: event.at, by: event.actor?.id ?? null });
        break;
      }
      case "operation_frozen": {
        const op = state.orders.get(event.orderId).instances.get(event.operationId);
        op.status = "frozen";
        op.freeze = { reason: event.reason, by: event.actor?.id ?? null, at: event.at };
        op.freezeHistory.push({ reason: event.reason, by: event.actor?.id ?? null, at: event.at, resumedAt: null, resumeNote: null });
        op.events.push({ type: "frozen", reason: event.reason, at: event.at, by: event.actor?.id ?? null });
        break;
      }
      case "operation_resumed": {
        const op = state.orders.get(event.orderId).instances.get(event.operationId);
        op.status = "in_progress";
        op.freeze = null;
        const last = op.freezeHistory[op.freezeHistory.length - 1];
        if (last && last.resumedAt == null) {
          last.resumedAt = event.at;
          last.resumeNote = event.note;
        }
        op.events.push({ type: "resumed", note: event.note, at: event.at, by: event.actor?.id ?? null });
        break;
      }
      case "operation_completed": {
        const op = state.orders.get(event.orderId).instances.get(event.operationId);
        op.status = "completed";
        op.completedAt = event.at;
        op.completedBy = event.actor?.id ?? null;
        op.events.push({ type: "completed", at: event.at, by: event.actor?.id ?? null });
        break;
      }
      case "operation_inspected": {
        const op = state.orders.get(event.orderId).instances.get(event.operationId);
        op.inspections.push({
          inspectionId: event.inspectionId,
          passed: event.passed,
          sample: event.sample,
          findings: event.findings,
          by: event.actor?.id ?? null,
          at: event.at,
        });
        op.status = event.passed ? "accepted" : "rejected";
        break;
      }
      case "material_claimed": {
        state.claims.set(event.claimId, {
          id: event.claimId,
          orderId: event.orderId,
          operationId: event.operationId,
          lotId: event.lotId,
          quantity: event.quantity,
          unit: event.unit,
          usedQuantity: 0,
          by: event.actor?.id ?? null,
          at: event.at,
        });
        break;
      }
      case "material_used": {
        const claim = state.claims.get(event.claimId);
        claim.usedQuantity += event.quantity;
        claim.usages ??= [];
        claim.usages.push({ usageId: event.usageId, quantity: event.quantity, by: event.actor?.id ?? null, at: event.at });
        break;
      }
      case "rework_requested": {
        state.reworks.set(event.reworkId, {
          id: event.reworkId,
          orderId: event.orderId,
          artifactId: event.artifactId,
          sourceOperationId: event.sourceOperationId,
          generation: event.generation,
          reason: event.reason,
          change: event.change,
          risks: event.risks,
          requiredExperts: event.requiredExperts,
          status: "awaiting_countersign",
          countersignatures: new Map(),
          requestedBy: event.actor?.id ?? null,
          createdAt: event.at,
          approvedAt: null,
          newOperationId: null,
        });
        break;
      }
      case "rework_countersigned": {
        const rework = state.reworks.get(event.reworkId);
        rework.countersignatures.set(event.expertId, { expertId: event.expertId, at: event.at });
        break;
      }
      case "rework_approved": {
        const rework = state.reworks.get(event.reworkId);
        rework.status = "approved";
        rework.approvedAt = event.at;
        rework.newOperationId = event.newOperationId;
        // 原工序实例被新一代取代：状态保留为 rejected（质控事实不可抹除），
        // 但不再是活动实例，不能继续领料或施工
        const source = state.orders.get(rework.orderId).instances.get(rework.sourceOperationId);
        source.active = false;
        source.supersededBy = `rework:${rework.id}`;
        break;
      }
      default:
        // 未知事件忽略，保持前向兼容
    }
  }

  // ---------- 内部：查找与校验 ----------

  #requireArtifact(id) {
    const artifact = this.state.artifacts.get(id);
    assert(artifact, 404, "artifact_not_found", "文物不存在");
    return artifact;
  }

  #requireLot(id) {
    const lot = this.state.lots.get(id);
    assert(lot, 404, "lot_not_found", "材料批次不存在");
    return lot;
  }

  #requireOrder(id) {
    const order = this.state.orders.get(id);
    assert(order, 404, "order_not_found", "工单不存在");
    return order;
  }

  #requireOperation(id) {
    for (const order of this.state.orders.values()) {
      const op = order.instances.get(id);
      if (op) return { order, op };
    }
    fail(404, "operation_not_found", "工序实例不存在");
  }

  #requireRework(id) {
    const rework = this.state.reworks.get(id);
    assert(rework, 404, "rework_not_found", "返工申请不存在");
    return rework;
  }

  #requireClaim(id) {
    const claim = this.state.claims.get(id);
    assert(claim, 404, "claim_not_found", "领料记录不存在");
    return claim;
  }

  #lotReserved(lotId) {
    let reserved = 0;
    for (const claim of this.state.claims.values()) {
      if (claim.lotId === lotId) reserved += claim.quantity;
    }
    return reserved;
  }
}

function createEmptyState() {
  return {
    nextSeq: 1,
    events: [],
    artifacts: new Map(),
    lots: new Map(),
    orders: new Map(),
    claims: new Map(),
    reworks: new Map(),
  };
}

// ---------- 纯函数：校验、派生、序列化 ----------

function currentPlan(order) {
  let latest = null;
  for (const plan of order.plans.values()) {
    if (!latest || plan.version > latest.version) latest = plan;
  }
  return latest;
}

function requirePlanVersion(order, version) {
  const plan = order.plans.get(version);
  assert(plan, 404, "plan_version_not_found", "方案版本不存在", { version });
  return plan;
}

function planQuorum(plan) {
  return plan.countersignatures.size >= plan.requiredExperts;
}

function planChanged(plan, next) {
  if (JSON.stringify(plan.content) !== JSON.stringify(next.content)) return true;
  const a = plan.phases.map((p) => ({ id: p.id, name: p.name, dependsOn: [...p.dependsOn].sort() }));
  const b = next.phases.map((p) => ({ id: p.id, name: p.name, dependsOn: [...p.dependsOn].sort() }));
  return JSON.stringify(a) !== JSON.stringify(b);
}

function validatePlanContent(content) {
  assert(content && typeof content === "object", 400, "invalid_content", "必须提供方案内容 content");
  assert(typeof content.adhesive === "string" && content.adhesive.trim(), 400, "invalid_content",
    "方案必须明确胶料 adhesive");
  assert(typeof content.drying === "string" && content.drying.trim(), 400, "invalid_content",
    "方案必须明确干燥步骤 drying");
}

function normalizePhases(phases) {
  assert(Array.isArray(phases) && phases.length > 0, 400, "invalid_phases", "方案至少包含一个工序");
  const ids = new Set();
  return phases.map((phase, index) => {
    assert(phase && typeof phase.name === "string" && phase.name.trim(), 400, "invalid_phases",
      `第 ${index + 1} 个工序名称不合法`);
    const id = typeof phase.id === "string" && /^[a-z0-9_-]{1,40}$/i.test(phase.id) ? phase.id : `p${index + 1}`;
    assert(!ids.has(id), 400, "duplicate_phase_id", `工序标识重复：${id}`);
    ids.add(id);
    const dependsOn = Array.isArray(phase.dependsOn) ? phase.dependsOn : [];
    for (const dep of dependsOn) {
      assert(typeof dep === "string", 400, "invalid_dependency", "工序依赖必须是工序标识");
    }
    return { id, name: phase.name.trim(), dependsOn: [...new Set(dependsOn)] };
  });
}

function assertDag(phases) {
  const byId = new Map(phases.map((phase) => [phase.id, phase]));
  for (const phase of phases) {
    for (const dep of phase.dependsOn) {
      assert(byId.has(dep), 400, "invalid_dependency",
        `工序 ${phase.name} 依赖了不存在的工序 ${dep}`);
      assert(dep !== phase.id, 400, "cyclic_dependency", `工序 ${phase.name} 不能依赖自身`);
    }
  }
  // Kahn 拓扑排序检测循环
  const indegree = new Map(phases.map((p) => [p.id, 0]));
  for (const phase of phases) {
    indegree.set(phase.id, phase.dependsOn.length);
  }
  const queue = phases.filter((p) => indegree.get(p.id) === 0).map((p) => p.id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift();
    visited += 1;
    for (const phase of phases) {
      if (phase.dependsOn.includes(id)) {
        indegree.set(phase.id, indegree.get(phase.id) - 1);
        if (indegree.get(phase.id) === 0) queue.push(phase.id);
      }
    }
  }
  assert(visited === phases.length, 400, "cyclic_dependency", "工序依赖存在循环");
}

function normalizeRisks(risks) {
  if (risks == null) return [];
  assert(Array.isArray(risks), 400, "invalid_risks", "风险说明必须是数组");
  return risks.map((risk, index) => {
    assert(risk && typeof risk.description === "string" && risk.description.trim(), 400, "invalid_risks",
      `第 ${index + 1} 条风险说明缺少 description`);
    const severity = risk.severity ?? "中";
    assert(["低", "中", "高"].includes(severity), 400, "invalid_risks",
      `风险等级必须为 低/中/高`);
    return { id: risk.id ?? `risk_${index + 1}`, description: risk.description.trim(), severity };
  });
}

function validateMeasurements(values) {
  assert(values && typeof values === "object", 400, "invalid_measurements", "检测值必须是结构化对象");
  for (const [key, value] of Object.entries(values)) {
    assert(typeof value === "number" && Number.isFinite(value), 400, "invalid_measurements",
      `检测项 ${key} 必须是数值`);
  }
}

function validateSample(sample) {
  assert(typeof sample.id === "string" && sample.id.trim(), 400, "invalid_sample", "验收样例缺少标识");
  assert(sample.expected !== undefined && sample.actual !== undefined, 400, "invalid_sample",
    "验收样例必须同时给出 expected 与 actual");
}

function parseDate(value, field) {
  assert(typeof value === "string", 400, "invalid_date", `${field} 必须是 ISO 8601 字符串`);
  const date = new Date(value);
  assert(!Number.isNaN(date.getTime()), 400, "invalid_date", `${field} 不是合法日期`);
  return value.length === 10 ? value : value.slice(0, 10);
}

function materializeInstance(order, spec, at) {
  const op = {
    id: spec.operationId,
    orderId: order.id,
    phaseId: spec.phaseId,
    name: spec.name,
    dependsOn: spec.dependsOn,
    planVersion: spec.planVersion,
    generation: spec.generation,
    reworkOf: spec.reworkOf ?? null,
    reworkId: spec.reworkId ?? null,
    status: "pending",
    active: true,
    freeze: null,
    freezeHistory: [],
    inspections: [],
    events: [{ type: "created", at }],
    startedAt: null,
    completedAt: null,
  };
  order.instances.set(op.id, op);
  order.instanceOrder.push(op.id);
}

function dependencyBlockers(order, op) {
  const blockers = [];
  for (const depPhaseId of op.dependsOn) {
    // 取该工序模板的最新一代实例
    let latest = null;
    for (const candidate of order.instances.values()) {
      if (candidate.phaseId === depPhaseId && (!latest || candidate.generation > latest.generation)) {
        latest = candidate;
      }
    }
    if (!latest || (latest.status !== "completed" && latest.status !== "accepted")) {
      blockers.push({ phaseId: depPhaseId, operationId: latest?.id ?? null, status: latest?.status ?? "missing" });
    }
  }
  return blockers;
}

function serializeArtifact(artifact) {
  return {
    id: artifact.id,
    name: artifact.name,
    measurements: artifact.measurements,
    createdAt: artifact.createdAt,
  };
}

function serializeLot(lot, state) {
  let reserved = 0;
  let used = 0;
  for (const claim of state.claims.values()) {
    if (claim.lotId === lot.id) {
      reserved += claim.quantity;
      used += claim.usedQuantity;
    }
  }
  return {
    id: lot.id,
    name: lot.name,
    supplier: lot.supplier,
    sourceEvidence: lot.sourceEvidence,
    quantity: lot.quantity,
    unit: lot.unit,
    expiryDate: lot.expiryDate,
    quarantine: lot.quarantine,
    reservedQuantity: round2(reserved),
    usedQuantity: round2(used),
    availableQuantity: round2(lot.quantity - reserved),
    createdAt: lot.createdAt,
  };
}

function planDisplayStatus(plan, order) {
  if (plan.status === PLAN_APPROVED) {
    let maxApproved = 0;
    for (const candidate of order.plans.values()) {
      if (candidate.status === PLAN_APPROVED && candidate.version > maxApproved) maxApproved = candidate.version;
    }
    return plan.version === maxApproved ? PLAN_APPROVED : PLAN_SUPERSEDED;
  }
  return plan.countersignatures.size >= plan.requiredExperts ? PLAN_APPROVED : PLAN_DRAFT;
}

function serializePlan(plan, order) {
  const status = planDisplayStatus(plan, order);
  return {
    version: plan.version,
    basedOnVersion: plan.basedOnVersion,
    status,
    content: plan.content,
    phases: plan.phases,
    risks: plan.risks,
    requiredExperts: plan.requiredExperts,
    countersignatures: [...plan.countersignatures.values()],
    draftedBy: plan.draftedBy,
    createdAt: plan.createdAt,
    approvedAt: status === PLAN_APPROVED ? (plan.approvedAt ?? "[已达会签人数]") : null,
  };
}

function serializeOperation(op) {
  return {
    id: op.id,
    orderId: op.orderId,
    phaseId: op.phaseId,
    name: op.name,
    dependsOn: op.dependsOn,
    planVersion: op.planVersion,
    generation: op.generation,
    reworkOf: op.reworkOf,
    reworkId: op.reworkId,
    status: op.status,
    active: op.active,
    supersededBy: op.supersededBy ?? null,
    freeze: op.freeze,
    freezeHistory: op.freezeHistory,
    inspections: op.inspections,
    startedAt: op.startedAt,
    completedAt: op.completedAt,
    eventLog: op.events,
  };
}

function serializeClaim(claim) {
  return {
    id: claim.id,
    orderId: claim.orderId,
    operationId: claim.operationId,
    lotId: claim.lotId,
    quantity: claim.quantity,
    unit: claim.unit,
    usedQuantity: round2(claim.usedQuantity),
    usages: claim.usages ?? [],
    by: claim.by,
    at: claim.at,
  };
}

function serializeRework(rework) {
  return {
    id: rework.id,
    orderId: rework.orderId,
    sourceOperationId: rework.sourceOperationId,
    generation: rework.generation,
    reason: rework.reason,
    change: rework.change,
    risks: rework.risks,
    requiredExperts: rework.requiredExperts,
    status: rework.status,
    countersignatures: [...rework.countersignatures.values()],
    requestedBy: rework.requestedBy,
    createdAt: rework.createdAt,
    approvedAt: rework.approvedAt,
    newOperationId: rework.newOperationId,
  };
}

function serializeTodo(order, op) {
  const blockers = op.status === "pending" ? dependencyBlockers(order, op) : [];
  return {
    orderId: order.id,
    artifactId: order.artifactId,
    operationId: op.id,
    name: op.name,
    phaseId: op.phaseId,
    generation: op.generation,
    reworkOf: op.reworkOf,
    status: op.status === "pending" && blockers.length ? "blocked" : op.status,
    frozenReason: op.freeze?.reason ?? null,
    waitingFor: blockers,
  };
}

function serializeOrder(order, state) {
  const plans = [...order.plans.values()].map((plan) => serializePlan(plan, order));
  const approvedVersions = plans.filter((p) => p.status === PLAN_APPROVED).map((p) => p.version);
  const latestVersion = Math.max(...plans.map((p) => p.version), 0);
  const approvedVersion = approvedVersions.length ? Math.max(...approvedVersions) : null;
  const operations = order.instanceOrder
    .map((id) => order.instances.get(id))
    .map(serializeOperation);
  const claims = [...state.claims.values()]
    .filter((claim) => claim.orderId === order.id)
    .map(serializeClaim);
  const reworks = [...state.reworks.values()]
    .filter((rework) => rework.orderId === order.id)
    .map(serializeRework);
  return {
    id: order.id,
    artifactId: order.artifactId,
    title: order.title,
    createdAt: order.createdAt,
    createdBy: order.createdBy,
    latestVersion: latestVersion || null,
    approvedVersion,
    plans,
    operations,
    materialClaims: claims,
    reworks,
  };
}

function timelineData(event) {
  const { seq, at, type, actor, artifactId, ...data } = event;
  return data;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}
