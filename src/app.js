import { createServer } from "node:http";
import { DomainError } from "./domain/errors.js";

const JSON_LIMIT = 1_048_576;

/**
 * @param {object} [options]
 * @param {import("./domain/service.js").RestorationService} [options.service]
 *        已初始化的领域服务；缺省时业务接口返回 503（健康检查仍可用）。
 */
export function createApp({ service } = {}) {
  const server = createServer((request, response) => {
    handle(request, response, service).catch((error) => {
      if (error instanceof DomainError) return sendError(response, error);
      console.error("未处理错误：", error);
      sendJson(response, 500, { error: "internal_error", message: "服务内部错误" });
    });
  });
  return server;
}

async function handle(request, response, service) {
  const url = new URL(request.url, "http://localhost");
  const { pathname } = url;

  if (request.method === "GET" && pathname === "/health") {
    sendJson(response, 200, { status: "ok", service: "heritage-service-starter" });
    return;
  }
  if (!pathname.startsWith("/api/")) {
    sendJson(response, 404, { error: "not_found" });
    return;
  }
  if (!service) {
    sendJson(response, 503, { error: "service_unavailable", message: "领域存储尚未就绪" });
    return;
  }

  // ---- 文物 / 工单 ----
  if (request.method === "POST" && pathname === "/api/artifacts") {
    return created(response, await service.registerArtifact(await readBody(request)));
  }
  let match;
  if ((match = pathname.match(/^\/api\/artifacts\/([^/]+)$/)) && request.method === "GET") {
    const artifact = service.projection.artifacts.get(decode(match[1]));
    if (!artifact) throw new DomainError("not_found", "文物不存在", 404);
    return sendJson(response, 200, artifact);
  }
  if ((match = pathname.match(/^\/api\/artifacts\/([^/]+)\/timeline$/)) && request.method === "GET") {
    return sendJson(response, 200, service.getTimeline(decode(match[1])));
  }
  if ((match = pathname.match(/^\/api\/artifacts\/([^/]+)\/timeline\.csv$/)) && request.method === "GET") {
    const csv = service.exportTimelineCsv(decode(match[1]));
    response.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="timeline-${match[1]}.csv"`,
    });
    response.end(csv);
    return;
  }
  if (request.method === "POST" && pathname === "/api/work-orders") {
    return created(response, await service.createWorkOrder(await readBody(request)));
  }
  if ((match = pathname.match(/^\/api\/work-orders\/([^/]+)$/)) && request.method === "GET") {
    return sendJson(response, 200, service.getWorkOrder(decode(match[1])));
  }

  // ---- 方案 ----
  if (request.method === "POST" && pathname === "/api/plans") {
    return created(response, await service.draftPlan(await readBody(request)));
  }
  if ((match = pathname.match(/^\/api\/plans\/([^/]+)$/)) && request.method === "GET") {
    return sendJson(response, 200, service.getPlan(decode(match[1])));
  }
  if ((match = pathname.match(/^\/api\/plans\/([^/]+)\/submit$/)) && request.method === "POST") {
    return sendJson(response, 200, await service.submitPlan({ ...(await readBody(request)), planId: decode(match[1]) }));
  }
  if ((match = pathname.match(/^\/api\/plans\/([^/]+)\/countersign$/)) && request.method === "POST") {
    return sendJson(response, 200, await service.countersign({ ...(await readBody(request)), planId: decode(match[1]) }));
  }
  if ((match = pathname.match(/^\/api\/plans\/([^/]+)\/decide$/)) && request.method === "POST") {
    return sendJson(response, 200, await service.decidePlan({ ...(await readBody(request)), planId: decode(match[1]) }));
  }

  // ---- 工序施工 ----
  if ((match = pathname.match(/^\/api\/phases\/([^/]+)\/start$/)) && request.method === "POST") {
    return sendJson(response, 200, await service.startPhase({ ...(await readBody(request)), instanceId: decode(match[1]) }));
  }
  if ((match = pathname.match(/^\/api\/phases\/([^/]+)\/complete$/)) && request.method === "POST") {
    return sendJson(response, 200, await service.completePhase({ ...(await readBody(request)), instanceId: decode(match[1]) }));
  }
  if ((match = pathname.match(/^\/api\/phases\/([^/]+)\/skip$/)) && request.method === "POST") {
    return sendJson(response, 200, await service.skipPhase({ ...(await readBody(request)), instanceId: decode(match[1]) }));
  }
  if ((match = pathname.match(/^\/api\/instances\/([^/]+)$/)) && request.method === "GET") {
    return sendJson(response, 200, service.getInstance(decode(match[1])));
  }
  if (request.method === "POST" && pathname === "/api/reworks") {
    return created(response, await service.openRework(await readBody(request)));
  }
  if (request.method === "GET" && pathname === "/api/todos") {
    return sendJson(response, 200, service.listTodos({ workOrderId: url.searchParams.get("workOrderId") ?? undefined }));
  }

  // ---- 材料 ----
  if (request.method === "POST" && pathname === "/api/material-batches") {
    return created(response, await service.registerMaterialBatch(await readBody(request)));
  }
  if (request.method === "GET" && pathname === "/api/material-batches") {
    return sendJson(response, 200, service.listBatches());
  }
  if ((match = pathname.match(/^\/api\/material-batches\/([^/]+)\/write-off$/)) && request.method === "POST") {
    return sendJson(response, 200, await service.writeOffMaterial({ ...(await readBody(request)), batchId: decode(match[1]) }));
  }
  if (request.method === "POST" && pathname === "/api/requisitions") {
    return created(response, await service.requisitionMaterial(await readBody(request)));
  }

  // ---- 质控 ----
  if (request.method === "POST" && pathname === "/api/qc") {
    return created(response, await service.recordQc(await readBody(request)));
  }

  sendJson(response, 404, { error: "not_found" });
}

function decode(value) {
  return decodeURIComponent(value);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > JSON_LIMIT) throw new DomainError("payload_too_large", "请求体超过 1MB", 413);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new DomainError("bad_request", "请求体必须是 JSON 对象");
    }
    // 允许用 x-actor 请求头代替/补充经办身份
    if (!body.actor && request.headers["x-actor"]) body.actor = String(request.headers["x-actor"]);
    return body;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError("bad_json", "请求体不是合法 JSON", 400);
  }
}

function sendError(response, error) {
  const body = { error: error.code, message: error.message };
  if (error.details) body.details = error.details;
  sendJson(response, error.status, body);
}

function created(response, body) {
  sendJson(response, 201, body);
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
