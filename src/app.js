import { createServer } from "node:http";
import { DomainError } from "./lib/errors.js";

const MAX_BODY_BYTES = 1_000_000;

/**
 * @param {import("./domain/service.js").RestorationService} service
 */
export function createApp(service) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const segments = path.split("/").slice(1);
      const query = url.searchParams;

      if (request.method === "GET" && path === "/health") {
        return send(response, 200, { status: "ok", service: "heritage-restoration-service" });
      }

      let body = null;
      if (request.method === "POST" || request.method === "PUT") {
        body = await readJson(request);
      }
      const ctx = { body, query, actor: resolveActor(request, body) };

      const route = match(request.method, segments);
      if (!route) return send(response, 404, { error: "not_found" });
      const result = await route.handler(service, route.params, ctx);
      const status = result?.status ?? 200;
      return send(response, status, result?.body ?? result ?? {});
    } catch (error) {
      if (error instanceof DomainError) {
        return send(response, error.status, { error: error.code, message: error.message, details: error.details });
      }
      if (error instanceof SyntaxError) {
        return send(response, 400, { error: "invalid_json", message: "请求体不是合法 JSON" });
      }
      console.error(error);
      return send(response, 500, { error: "internal_error" });
    }
  });
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new DomainError(413, "payload_too_large", "请求体过大"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

const ROLE_CODES = {
  admin: "管理员",
  restorer: "保护人员",
  expert: "专家",
  qc: "质控",
  visitor: "只读访客",
};

function normalizeRole(role) {
  if (role == null) return "保护人员";
  return ROLE_CODES[String(role).toLowerCase()] ?? String(role);
}

function resolveActor(request, body) {
  const id = header(request, "x-actor-id") ?? body?.actor?.id ?? "anonymous";
  const role = normalizeRole(header(request, "x-actor-role") ?? body?.actor?.role);
  return { id, role, name: body?.actor?.name ?? null };
}

function header(request, name) {
  const value = request.headers[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function ok(body, status = 200) {
  return { body, status };
}

// GET 不读 body，身份由 x-actor-* 请求头提供（见 resolveActor）
function match(method, segments) {
  for (const route of routes) {
    if (route.method !== method || route.parts.length !== segments.length) continue;
    const params = {};
    let matched = true;
    for (let i = 0; i < route.parts.length; i += 1) {
      const part = route.parts[i];
      if (part.startsWith(":")) params[part.slice(1)] = segments[i];
      else if (part !== segments[i]) { matched = false; break; }
    }
    if (matched) return { handler: route.handler, params };
  }
  return null;
}

const routes = [
  // 文物与检测
  { method: "POST", parts: ["artifacts"], handler: async (s, _p, ctx) =>
    ok(await s.registerArtifact({ ...ctx.body, actor: ctx.actor }), 201) },
  { method: "GET", parts: ["artifacts"], handler: async (s) => ok({ artifacts: s.listArtifacts() }) },
  { method: "GET", parts: ["artifacts", ":id"], handler: async (s, p) => ok(await s.getArtifact(p.id)) },
  { method: "POST", parts: ["artifacts", ":id", "measurements"], handler: async (s, p, ctx) =>
    ok(await s.addMeasurement(p.id, { ...ctx.body, actor: ctx.actor }), 201) },
  { method: "GET", parts: ["artifacts", ":id", "timeline"], handler: async (s, p, ctx) => {
    requireAdmin(ctx, "导出修复时间线");
    return ok(await s.getTimeline(p.id));
  } },

  // 材料批次
  { method: "POST", parts: ["material-lots"], handler: async (s, _p, ctx) =>
    ok(await s.registerMaterialLot({ ...ctx.body, actor: ctx.actor }), 201) },
  { method: "GET", parts: ["material-lots"], handler: async (s) => ok({ lots: s.listMaterialLots() }) },
  { method: "GET", parts: ["material-lots", ":id"], handler: async (s, p) => ok(await s.getMaterialLot(p.id)) },
  { method: "POST", parts: ["material-lots", ":id", "quarantine"], handler: async (s, p, ctx) =>
    ok(await s.quarantineMaterialLot(p.id, { ...ctx.body, actor: ctx.actor })) },

  // 工单
  { method: "POST", parts: ["work-orders"], handler: async (s, _p, ctx) =>
    ok(await s.createWorkOrder({ ...ctx.body, actor: ctx.actor }), 201) },
  { method: "GET", parts: ["work-orders"], handler: async (s) => ok({ workOrders: s.listWorkOrders() }) },
  { method: "GET", parts: ["work-orders", ":id"], handler: async (s, p) => ok(await s.getWorkOrder(p.id)) },

  // 方案草拟与会签
  { method: "POST", parts: ["work-orders", ":id", "plans"], handler: async (s, p, ctx) =>
    ok(await s.draftPlan(p.id, { ...ctx.body, actor: ctx.actor }), 201) },
  { method: "GET", parts: ["work-orders", ":id", "plans", ":version"], handler: async (s, p) =>
    ok(await s.getPlan(p.id, Number(p.version))) },
  { method: "POST", parts: ["work-orders", ":id", "plans", ":version", "countersign"], handler: async (s, p, ctx) =>
    ok(await s.countersignPlan(p.id, Number(p.version), { actor: ctx.actor })) },

  // 施工
  { method: "POST", parts: ["operations", ":id", "start"], handler: async (s, p, ctx) =>
    ok(await s.startOperation(p.id, { actor: ctx.actor })) },
  { method: "POST", parts: ["operations", ":id", "freeze"], handler: async (s, p, ctx) =>
    ok(await s.freezeOperation(p.id, { ...ctx.body, actor: ctx.actor })) },
  { method: "POST", parts: ["operations", ":id", "resume"], handler: async (s, p, ctx) =>
    ok(await s.resumeOperation(p.id, { ...ctx.body, actor: ctx.actor })) },
  { method: "POST", parts: ["operations", ":id", "complete"], handler: async (s, p, ctx) =>
    ok(await s.completeOperation(p.id, { actor: ctx.actor })) },
  { method: "POST", parts: ["operations", ":id", "inspect"], handler: async (s, p, ctx) =>
    ok(await s.inspectOperation(p.id, { ...ctx.body, actor: ctx.actor })) },
  { method: "GET", parts: ["operations", ":id"], handler: async (s, p) => ok(await s.getOperation(p.id)) },

  // 返工
  { method: "POST", parts: ["operations", ":id", "rework"], handler: async (s, p, ctx) =>
    ok(await s.requestRework(p.id, { ...ctx.body, actor: ctx.actor }), 201) },
  { method: "POST", parts: ["reworks", ":id", "countersign"], handler: async (s, p, ctx) =>
    ok(await s.countersignRework(p.id, { actor: ctx.actor })) },
  { method: "GET", parts: ["reworks", ":id"], handler: async (s, p) => ok(await s.getRework(p.id)) },

  // 材料领用与用量
  { method: "POST", parts: ["material-claims"], handler: async (s, _p, ctx) =>
    ok(await s.claimMaterial({ ...ctx.body, actor: ctx.actor }), 201) },
  { method: "GET", parts: ["material-claims", ":id"], handler: async (s, p) => ok(await s.getClaim(p.id)) },
  { method: "POST", parts: ["material-claims", ":id", "usages"], handler: async (s, p, ctx) =>
    ok(await s.recordUsage(p.id, { ...ctx.body, actor: ctx.actor }), 201) },

  // 待办
  { method: "GET", parts: ["todos"], handler: async (s, _p, ctx) =>
    ok({ todos: s.listTodos(ctx.query.get("actorId")) }) },
];

function requireAdmin(ctx, action) {
  if (ctx.actor.role !== "管理员") {
    const error = new DomainError(403, "forbidden", `只有管理员可以${action}`);
    throw error;
  }
  return false;
}

function send(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}
