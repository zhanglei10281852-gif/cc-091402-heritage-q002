import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { EventStore } from "./domain/store.js";
import { RestorationService } from "./domain/service.js";

const config = loadConfig();
const store = new EventStore(config.dataFile);
const service = new RestorationService({ store });

try {
  await service.init();
} catch (error) {
  console.error("领域存储初始化失败，拒绝在不完整历史上启动：", error.message);
  process.exit(1);
}

const server = createApp({ service });
server.listen(config.port, config.host, () => {
  console.log(`文物修复工单服务已启动：http://${config.host}:${config.port}`);
  console.log(`事件日志：${config.dataFile}`);
});

const shutdown = async (signal) => {
  console.log(`收到 ${signal}，开始优雅停机…`);
  server.close(() => process.exit(0));
  // 强制退出兜底
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
