# 文物修复工单服务

面向纸质文物（受潮古籍等）修复业务的 Node.js 服务：方案草拟与版本化、专家会签、
分阶段施工（带工序依赖）、材料批次领用、质控验收与返工，每次方案变更强制绑定风险说明，
全部业务动作进入只追加的哈希链事件日志，服务重启后可完整重建待办、冻结原因、库存与责任链，
管理员可导出单件文物的完整修复时间线。

## 核心约束的落地方式

- **方案变更绑定风险说明**：`riskNote`（概述/影响工序/应对措施/残余风险）是草拟方案的必填结构化字段，与方案版本同事件入库。
- **专家会签**：草案送审后专家一人一签，任一驳回即驳回，批准需达到会签人数（≥2，最多 5）。
- **已开始的工序不能被静默改写**：新方案批准时，`active/done/skipped` 旧实例原样沿用；只有未开工实例被冻结（记录原因、风险与接替实例）。
- **过期/来源不明材料阻止领用**：领用校验有效期、供应商与质检证书、库存、工序状态，分别返回 `batch_expired` / `batch_origin_unknown` / `insufficient_stock`。
- **返工生成新实例**：`rework_opened` 产生全新工序实例，原实例施工/领料/质控记录保留，双向关联。
- **并发领料一致**：所有写命令经串行队列执行“校验→落盘→投影”，并发不超卖，库存与用量逐笔可对。
- **崩溃可恢复、责任可追溯**：JSONL 事件日志 + SHA-256 哈希链；启动回放重建全部状态，链被篡改则拒绝启动。

## 运行

需要 Node.js 22+。

```bash
npm ci
npm start          # 默认 :8000，事件日志 ./.runtime/events.jsonl
npm test           # node --test
```

也可 `docker compose up --build`。

配置：`PORT` / `HOST` / `RESTORATION_DATA_FILE`。

## 接口

见 [docs/api.md](docs/api.md)，领域约定见 [docs/domain.md](docs/domain.md)。

主要流程：

```
POST /api/artifacts                         登记文物（含修复前检测值）
POST /api/work-orders                       创建工单
POST /api/plans                             草拟/修订方案（必填 riskNote）
POST /api/plans/:id/submit|countersign|decide   送审 → 专家会签 → 批准
GET  /api/todos?workOrderId=                待办（含依赖阻塞）
POST /api/phases/:id/start|complete|skip    分阶段施工
POST /api/material-batches                  批次入库（有效期/供应商/证书）
POST /api/requisitions                      领料（过期、来源不明、库存不足均拦截）
POST /api/qc                                质控/验收（修复后检测值）
POST /api/reworks                           返工（生成新工序实例）
GET  /api/artifacts/:id/timeline[.csv]      完整修复时间线 / 管理员导出
```

## 代码结构

```
src/
  config.js            运行配置
  app.js               HTTP 路由与 JSON 错误映射
  index.js             启动：加载事件日志 → 重建投影 → 起服务
  domain/
    events.js          事件规范化哈希与哈希链校验
    store.js           追加式 JSONL 存储（append+fsync，启动验链）
    projector.js       事件回放投影（工单/方案/工序/批次/领用/质控）
    service.js         领域命令：串行事务、校验、时间线与 CSV
    errors.js          领域错误（错误码 + HTTP 状态）
tests/                 node:test 端到端/并发/恢复/防篡改测试
```
