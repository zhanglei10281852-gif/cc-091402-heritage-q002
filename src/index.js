import { createApp } from "./app.js";
import { EventStore } from "./lib/event-store.js";
import { RestorationService } from "./domain/service.js";
import { mkdir } from "node:fs/promises";

const port = Number.parseInt(process.env.PORT ?? "8000", 10);
const host = process.env.HOST ?? "0.0.0.0";
const dataDir = process.env.DATA_DIR ?? ".data";

await mkdir(dataDir, { recursive: true });
const store = new EventStore({ dir: dataDir });
await store.init();
const service = new RestorationService(store);
await service.load();

const server = createApp(service);
await new Promise((resolve) => server.listen(port, host, resolve));
console.log(`文物修复工单服务已启动，监听 ${host}:${port}，数据目录 ${dataDir}`);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`收到 ${signal}，开始优雅关闭`);
  server.close(async () => {
    await service.close();
    process.exit(0);
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
