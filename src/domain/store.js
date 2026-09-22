import { mkdir, readFile, rename, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { GENESIS_HASH, hashEvent } from "./events.js";
import { DomainError } from "./errors.js";

/**
 * 追加式 JSONL 事件存储。
 * - 写入：单行 appendFile 后立即 fsync，成功才更新内存索引；
 * - 启动：回放整份日志并校验哈希链，链断裂则拒绝启动，
 *   避免在被篡改/损坏的历史上继续记账。
 * - 业务并发由上层 Service 的命令队列串行化。
 */
export class EventStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.events = [];
    this.tail = GENESIS_HASH;
    this.handle = null;
  }

  async load() {
    if (!existsSync(this.filePath)) {
      await mkdir(dirname(this.filePath), { recursive: true });
      return;
    }
    const raw = await readFile(this.filePath, "utf8");
    let prev = GENESIS_HASH;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        throw new DomainError("log_corrupt", "事件日志包含无法解析的行", 500);
      }
      if (event.prev !== prev || hashEvent(event) !== event.hash) {
        throw new DomainError(
          "chain_broken",
          `事件哈希链在 ${event.id ?? "未知事件"} 处断裂，拒绝加载历史`,
          500,
        );
      }
      prev = event.hash;
      this.events.push(event);
    }
    this.tail = prev;
  }

  async open() {
    await mkdir(dirname(this.filePath), { recursive: true });
    this.handle = await open(this.filePath, "a");
  }

  async close() {
    if (this.handle) {
      await this.handle.close();
      this.handle = null;
    }
  }

  /** 先落盘并 fsync，成功后才更新内存索引 */
  async append(event) {
    await this.handle.appendFile(`${JSON.stringify(event)}\n`);
    await this.handle.sync();
    this.events.push(event);
    this.tail = event.hash;
  }

  /** 压缩重写日志（维护用）：原子替换并接续哈希链 */
  async rewrite(allEvents) {
    const tmp = `${this.filePath}.tmp`;
    const handle = await open(tmp, "w");
    try {
      for (const event of allEvents) {
        await handle.appendFile(`${JSON.stringify(event)}\n`);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, this.filePath);
  }

  all() {
    return this.events;
  }
}
