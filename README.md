# 纸质文物修复工单服务

面向受潮古籍等纸质文物修复的 Node.js 工单服务，覆盖**方案草拟 → 专家会签 → 分阶段施工 → 材料批次领用 → 质控验收 → 返工**全流程，并为管理员提供单件文物的完整修复时间线导出。

需要 Node.js 22+，无第三方运行时依赖。`npm start` 启动（默认 `0.0.0.0:8000`，数据目录由 `DATA_DIR` 指定，默认 `.data/`）；`npm test` 执行测试。

## 核心规则

- **方案变更必须绑定风险说明**：每个方案版本保存胶料、干燥步骤、分阶段工序及其依赖；除首版外，任何草拟都必须带至少一条风险（描述 + 低/中/高等级），且内容确实发生变化。基于过期版本提交返回 `version_conflict`。
- **已开始的工序不能被静默改写**：任一工序开工后，直接改方案返回 `plan_locked`；旧方案中尚未开工的待办工序在新版本批准后标记为 `superseded`，已开工/已完工实例绝不动。
- **返工生成新实例**：质控不通过（或已验收后复检发现问题）可发起返工，返工方案同样需要风险说明与专家会签；会签通过后生成 `generation + 1` 的新工序实例（`reworkOf` 指回原实例），原记录完整保留。
- **材料管控**：入库必须提供供应商与溯源凭证（来源不明拒绝入库）；过期或被封存的批次禁止领用。
- **并发一致**：所有命令在进程内串行提交，多个修复师同时抢领同一批材料时，库存（总量/已预留/可用）与用量统计保持一致，超额请求返回 `insufficient_stock`。
- **可恢复、可追溯**：唯一事实来源是仅追加、逐行 fsync 的事件日志（`$DATA_DIR/events.log`）；重启重放后，待办、冻结原因、领料库存和责任链（谁、何时、做了什么）均可查询。时间字段统一为带时区 ISO 8601。

## 身份

请求通过 `x-actor-id` 与 `x-actor-role` 头标识经办人（HTTP 头只能是 ASCII，角色用代码）：

| 头值 | 角色 |
| --- | --- |
| `admin` | 管理员（可导出时间线） |
| `restorer` | 保护人员（修复师） |
| `expert` | 修复专家（方案/返工回签） |
| `qc` | 质控 |

也可在 POST 的 JSON 体内提供 `{"actor": {"id": "...", "role": "专家"}}`（角色可用中文）。

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 存活检查 |
| POST | `/artifacts` | 登记文物（可带修复前检测值） |
| GET | `/artifacts` · `/artifacts/:id` | 文物列表/详情（含各阶段检测值） |
| POST | `/artifacts/:id/measurements` | 追加 before/during/after 检测值 |
| GET | `/artifacts/:id/timeline` | **管理员**导出完整修复时间线与责任链 |
| POST | `/material-lots` | 登记材料批次（供应商、溯源凭证、有效期、库存量） |
| GET | `/material-lots` · `/material-lots/:id` | 批次查询（总量/已预留/已用/可用） |
| POST | `/material-lots/:id/quarantine` | 封存批次（附原因） |
| POST | `/work-orders` | 创建工单 |
| GET | `/work-orders` · `/work-orders/:id` | 工单查询（方案、全部工序实例、领料、返工） |
| POST | `/work-orders/:id/plans` | 草拟方案版本（变更须带 `risks`，可用 `basedOnVersion` 乐观并发控制） |
| GET | `/work-orders/:id/plans/:version` | 查询某一版方案 |
| POST | `/work-orders/:id/plans/:version/countersign` | 专家会签，达到 `requiredExperts` 人自动批准 |
| POST | `/operations/:id/start` | 开工（前置工序未完成返回 `dependencies_unmet`） |
| POST | `/operations/:id/freeze` · `/resume` | 冻结（附原因）/ 解除冻结 |
| POST | `/operations/:id/complete` | 完工 |
| POST | `/operations/:id/inspect` | 提交验收样例与质控结论 |
| POST | `/operations/:id/rework` | 发起返工（必须带风险说明） |
| POST | `/reworks/:id/countersign` | 专家会签返工，通过后生成新工序实例 |
| POST | `/material-claims` | 领用材料（拦截过期/封存/来源不明/库存不足） |
| POST | `/material-claims/:id/usages` | 登记实际用量（不得超过领用量） |
| GET | `/todos?actorId=` | 待办与在办（含冻结原因、依赖阻塞） |

错误统一为 `{ "error": "code", "message": "...", "details": {} }`，常见码：`version_conflict`、`plan_locked`、`risk_required`、`dependencies_unmet`、`material_expired`、`material_quarantined`、`source_unknown`、`insufficient_stock`、`cyclic_dependency`。

## 示例流程

```bash
# 1. 登记文物（修复前检测值）与工单
curl -s localhost:8000/artifacts -H 'content-type: application/json' \
  -H 'x-actor-id: admin-1' -H 'x-actor-role: admin' \
  -d '{"id":"artifact-0001","name":"受潮宋版文选残卷","measurements":{"含水率":18.2,"pH":5.4}}'

curl -s localhost:8000/work-orders -H 'content-type: application/json' \
  -H 'x-actor-id: r1' -H 'x-actor-role: restorer' \
  -d '{"id":"order-1","artifactId":"artifact-0001","title":"首批受潮古籍修复"}'

# 2. 草拟方案：胶料 + 干燥步骤 + 分阶段工序（dependsOn 表达工序依赖）
curl -s localhost:8000/work-orders/order-1/plans -H 'content-type: application/json' \
  -H 'x-actor-id: r1' -H 'x-actor-role: restorer' \
  -d '{"content":{"adhesive":"小麦淀粉浆","drying":"阴干72小时"},
       "phases":[{"id":"clean","name":"表面去污除霉"},
                 {"id":"backing","name":"补缀托裱","dependsOn":["clean"]}],
       "requiredExperts":2}'

# 3. 两位专家会签（达到人数自动批准，生成工序实例 op_order-1_v1_clean 等）
curl -s -XPOST localhost:8000/work-orders/order-1/plans/1/countersign \
  -H 'x-actor-id: e1' -H 'x-actor-role: expert'

# 4. 临时换胶料：新版本必须绑定风险说明
curl -s localhost:8000/work-orders/order-1/plans -H 'content-type: application/json' \
  -H 'x-actor-id: r1' -H 'x-actor-role: restorer' \
  -d '{"content":{"adhesive":"甲基纤维素","drying":"低湿烘干6小时"},
       "phases":[{"id":"clean","name":"表面去污除霉"},
                 {"id":"backing","name":"补缀托裱","dependsOn":["clean"]}],
       "risks":[{"description":"新旧胶料相容性未知，可能色差","severity":"高"}]}'

# 5. 材料批次入库（必须有供应商+溯源凭证+有效期），再领用
curl -s localhost:8000/material-lots -H 'content-type: application/json' \
  -H 'x-actor-id: admin-1' -H 'x-actor-role: admin' \
  -d '{"id":"lot-1","name":"甲基纤维素","supplier":"西泠文保材料公司",
       "sourceEvidence":"COA-2026-09","quantity":10,"expiryDate":"2026-12-31"}'

curl -s localhost:8000/material-claims -H 'content-type: application/json' \
  -H 'x-actor-id: r1' -H 'x-actor-role: restorer' \
  -d '{"orderId":"order-1","operationId":"op_order-1_v2_clean","lotId":"lot-1","quantity":2}'

# 6. 管理员导出完整时间线（事件流 + 按经办人聚合的责任链）
curl -s localhost:8000/artifacts/artifact-0001/timeline \
  -H 'x-actor-id: admin-1' -H 'x-actor-role: admin'
```

## 架构

- `src/lib/event-store.js`：仅追加 JSONL 事件日志，每条事件 fsync，启动时重放；末尾半行（崩溃截断）自动裁剪。
- `src/domain/service.js`：领域服务。投影全部由事件重放得到；命令经单条 Promise 链串行化，在同一临界区内完成"校验 → 落盘 → 更新投影"。
- `src/app.js`：原生 `node:http` 路由与 JSON/错误处理，无框架依赖。
- `tests/`：`node --test` 共 18 项，覆盖会签、版本冲突、开工锁定、依赖、冻结、返工新实例、材料拦截、并发领料、崩溃恢复与时间线。
