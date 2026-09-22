import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";

/**
 * 仅追加事件日志：所有业务状态的唯一事实来源。
 * 每条事件以单行 JSON 落盘并 fsync，进程重启后通过重放恢复全部状态，
 * 因此待办、冻结原因与责任链在服务恢复后仍然可查。
 */
export class EventStore {
  constructor({ dir }) {
    this.dir = dir;
    this.file = join(dir, "events.log");
    this.fh = null;
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
    this.fh = await open(this.file, "a");
  }

  async readAll() {
    let handle;
    try {
      handle = await open(this.file, "r");
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    try {
      const buffer = await handle.readFile();
      const text = buffer.toString("utf8");
      if (text === "") return [];
      const events = [];
      const lines = text.split("\n");
      // 文件以换行结尾时末尾会多出一个空串
      if (lines[lines.length - 1] === "") lines.pop();
      for (const [index, line] of lines.entries()) {
        try {
          events.push(JSON.parse(line));
        } catch (error) {
          if (index !== lines.length - 1) {
            throw new Error(`事件日志第 ${index + 1} 行损坏`, { cause: error });
          }
          // 最后一行无法解析：上次写入可能在落盘中途崩溃，截掉这半行
          const prefix = lines.slice(0, index).join("\n");
          const goodBytes = Buffer.byteLength(prefix, "utf8") + (prefix ? 1 : 0);
          await this.fh.truncate(goodBytes);
          break;
        }
      }
      return events;
    } finally {
      await handle.close();
    }
  }

  async append(event) {
    const chunk = JSON.stringify(event) + "\n";
    await this.fh.write(chunk);
    await this.fh.sync();
  }

  async close() {
    if (this.fh) {
      await this.fh.sync().catch(() => {});
      await this.fh.close();
      this.fh = null;
    }
  }
}
