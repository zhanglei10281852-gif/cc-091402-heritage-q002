# 修复工单服务 API

所有接口除健康检查外位于 `/api` 前缀下，请求/响应均为 UTF-8 JSON。
经办身份通过请求体 `actor`（不可变身份字符串）提交，也可用 `X-Actor` 请求头。
时间字段统一为带时区的 ISO 8601 字符串。

领域错误统一返回：

```json
{ "error": "错误码", "message": "中文说明", "details": { } }
```

## 角色

- 管理员：导出文物完整修复时间线（JSON/CSV）、核销材料
- 保护人员（修复师/质控员/库房管理员）：方案、施工、领料、质控、返工
- 只读访客：查询待办、工单、方案、工序、库存与时间线

## 文物与工单

### 登记文物 `POST /api/artifacts`

```json
{
  "artifactId": "artifact-0001",
  "name": "受潮古籍《治水要旨》",
  "actor": "curator-li",
  "accessionNo": "故-0001",
  "initialCondition": "书口霉变，含水率偏高",
  "measurements": [
    { "metric": "含水率", "value": 18.2, "unit": "%", "stage": "repair_before" }
  ]
}
```

检测值 `unit` 允许空串（pH、ΔE 等无量纲指标）。

### 创建工单 `POST /api/work-orders`

```json
{ "workOrderId": "wo-0001", "artifactId": "artifact-0001", "title": "脱酸修复", "actor": "curator-li" }
```

### 查询工单 `GET /api/work-orders/:id`

返回当前生效方案、全部版本历史、全部工序实例（含冻结、返工链）、冻结记录。

### 查询文物 / 时间线

- `GET /api/artifacts/:id`
- `GET /api/artifacts/:id/timeline` —— 该文物跨工单的**完整事件时间线**，含经办人、时间、前后哈希
- `GET /api/artifacts/:id/timeline.csv` —— 管理员导出（带 BOM，Excel 可直接打开）

## 方案草拟、修订与专家会签

### 草拟/修订方案 `POST /api/plans`

每次方案变更都**必须绑定结构化风险说明** `riskNote`，且要重新走送审会签。

```json
{
  "workOrderId": "wo-0001",
  "actor": "restorer-wang",
  "changeSummary": "胶料改为甲基纤维素；干燥改低温真空",
  "riskNote": {
    "summary": "新旧胶料相容性存疑，可能色差",
    "affectedPhases": ["drying"],
    "mitigations": "先做小样对照 24 小时",
    "residualRisk": "ΔE 可能高于 1.5"
  },
  "phases": [
    { "code": "cleaning", "name": "除尘去霉" },
    { "code": "deacidification", "name": "脱酸", "dependsOn": ["cleaning"] },
    { "code": "drying", "name": "低温真空干燥", "dependsOn": ["deacidification"] }
  ],
  "materials": [
    { "name": "甲基纤维素", "plannedQuantity": 300, "unit": "g" }
  ]
}
```

- 不填 `planId` 自动生成；不填 `supersedesPlanId` 默认修订该工单**最新一版**方案。
- 上一版尚在草拟/送审时不能另起修订稿（`prior_plan_not_decided`）。
- 工序依赖不能引用不存在的编码、不能自依赖、不能成环。

### 方案流转

- `POST /api/plans/:id/submit` —— 草稿送审
- `POST /api/plans/:id/countersign` —— 专家会签 `{ "actor": "expert-zhao", "decision": "approve|reject", "comment": "" }`
  - 同一专家不能重复签署（`already_countersigned`）
  - 会签人数要求：至少 2 名，随方案材料数增加，上限 5
- `POST /api/plans/:id/decide` —— 落锤批准/驳回
  - 任一驳回 → `rejected`，不生成任何工序
  - 全数同意 → `approved`，并自动做工序衔接

**方案批准时的工序衔接规则（核心）**：

| 旧方案实例状态 | 处理 |
|---|---|
| `active` 施工中 / `done` 已完工 / `skipped` 已跳过 | **保持原实例不动**，挂接到新方案继续沿用，绝不静默改写 |
| `pending` 未开工 | 冻结（`frozen`），冻结原因绑定本次变更与风险，若新方案保留同编码工序则记录接替实例 |
| 新方案新增工序 | 直接生成新的待办实例 |

## 分阶段施工

- `POST /api/phases/:instanceId/start` —— 开工；前置依赖未了结返回 `dependencies_unmet`
- `POST /api/phases/:instanceId/complete` —— 完工，可带 `result` 与 `measurements`
- `POST /api/phases/:instanceId/skip` —— 跳过（仅未开工实例，需原因）；已开工实例不能跳过
- `GET /api/instances/:id` —— 工序详情（含领料记录、质控记录、返工链、冻结原因）
- `GET /api/todos?workOrderId=` —— 待办列表，含 `ready` 与 `blocking` 依赖

依赖判定以每个工序编码的**最新实例**为准：上游旧实例虽已完工，但如因质控不合格开了返工，
下游必须等返工实例完工才放行；`skipped` 视为依赖已了结。

## 材料批次与领用

### 批次入库 `POST /api/material-batches`

```json
{
  "batchId": "batch-0001",
  "name": "甲基纤维素",
  "materialCode": "MC",
  "quantity": 10,
  "unit": "g",
  "expiresAt": "2099-01-01T00:00:00Z",
  "supplier": "故宫文保材料厂",
  "certificateNo": "CERT-2026-001",
  "actor": "keeper-zhou"
}
```

- 入库强制要求供应商（来源不明不能入库）；`certificateNo` 缺省时允许入库但**禁止领用**。
- `GET /api/material-batches` 查看全部批次与实时余量。
- `POST /api/material-batches/:id/write-off` —— 管理员/库房核销（过期、损毁等，需原因）。

### 领用 `POST /api/requisitions`

```json
{ "instanceId": "inst-...", "batchId": "batch-0001", "quantity": 2, "purpose": "书口局部", "actor": "restorer-chen" }
```

拦截规则（错误码）：

- `not_found` 批次不存在
- `batch_expired` 已过有效期（返回 `expiresAt` 与当前时间）
- `batch_origin_unknown` 缺供应商或质检证书
- `insufficient_stock` 库存不足（含并发竞争耗尽）
- `instance_not_workable` / `instance_closed` 工序冻结/跳过/已完工（完工后要领料须先开返工）

多个修复师并发领取同一批次时，命令经服务内串行队列执行：库存逐笔扣减、落盘、投影，
保证不超卖，`remainingQuantity` 与批次 `requisitionIds` 用量始终一致。

## 质控与返工

### 质控记录 `POST /api/qc`

```json
{
  "instanceId": "inst-...",
  "stage": "repair_before | repair_after | acceptance",
  "result": "pass | fail | conditional",
  "findings": "局部酸度偏高",
  "measurements": [{ "metric": "pH", "value": 6.1 }],
  "actor": "qc-li"
}
```

### 开返工 `POST /api/reworks`

```json
{ "instanceId": "inst-...(原实例)", "reason": "验收不合格", "actor": "qc-li" }
```

- 只能对 `done`/`skipped` 实例开返工。
- **生成全新工序实例**（`newInstanceId`，`status=pending`），原实例保持 `done` 不覆盖，
  其施工、领料、质控记录完整保留；两实例通过 `originInstanceId` / `reworkInstanceIds` 双向关联。
- 返工实例独立走开工→施工→质控流程。

## 健康检查

`GET /health` → `{ "status": "ok", "service": "heritage-service-starter" }`
仅表示进程存活，不代表任何业务流程已完成。

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `RESTORATION_DATA_FILE` | `./.runtime/events.jsonl` | 追加式事件日志路径 |
