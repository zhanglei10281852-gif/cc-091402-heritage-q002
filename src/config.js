import path from "node:path";

export function loadConfig(env = process.env) {
  return {
    port: Number.parseInt(env.PORT ?? "8000", 10),
    host: env.HOST ?? "0.0.0.0",
    dataFile: env.RESTORATION_DATA_FILE ?? path.join(process.cwd(), ".runtime", "events.jsonl"),
  };
}
