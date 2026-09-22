import crypto from "node:crypto";

export const GENESIS_HASH = "0".repeat(64);

/** 对业务事件做规范化序列化（键排序），用于哈希链 */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

/**
 * 构造一条完整事件（含 prev/hash）。
 * 事件形态：{ id, type, at, actor, artifactId, payload, prev, hash }
 */
export function mintEvent(spec, prevHash) {
  const event = {
    id: crypto.randomUUID(),
    type: spec.type,
    at: spec.at,
    actor: spec.actor,
    artifactId: spec.artifactId ?? null,
    payload: spec.payload ?? {},
    prev: prevHash,
  };
  event.hash = crypto.createHash("sha256").update(stableStringify(event)).digest("hex");
  return event;
}

export function hashEvent(event) {
  const { hash, ...body } = event;
  return crypto.createHash("sha256").update(stableStringify(body)).digest("hex");
}

/** 校验整条哈希链，返回 { ok, brokenAt } */
export function verifyChain(events) {
  let prev = GENESIS_HASH;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.prev !== prev || hashEvent(event) !== event.hash) {
      return { ok: false, brokenAt: index, eventId: event.id };
    }
    prev = event.hash;
  }
  return { ok: true, count: events.length };
}
