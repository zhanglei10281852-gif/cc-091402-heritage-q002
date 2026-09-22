import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { EventStore } from "../src/lib/event-store.js";
import { RestorationService } from "../src/domain/service.js";

const openStores = new Set();
after(async () => {
  for (const store of openStores) {
    await store.close().catch(() => {});
  }
  openStores.clear();
});

export async function createTestService(clock) {
  const dir = await mkdtemp(join(tmpdir(), "restoration-"));
  const store = new EventStore({ dir });
  await store.init();
  openStores.add(store);
  const options = clock ? { now: typeof clock === "function" ? clock : clock.now } : {};
  const service = new RestorationService(store, options);
  await service.load();
  return { service, dir, store };
}

export function clockAt(iso) {
  let t = Date.parse(iso);
  return {
    now: () => new Date(t),
    advance(ms) { t += ms; },
  };
}

export const ACTORS = {
  admin: { id: "admin-1", role: "管理员", name: "周馆长" },
  restorer: { id: "restorer-1", role: "保护人员", name: "陈修复" },
  restorer2: { id: "restorer-2", role: "保护人员", name: "林修复" },
  expert1: { id: "expert-1", role: "专家", name: "李专家" },
  expert2: { id: "expert-2", role: "专家", name: "王专家" },
};
