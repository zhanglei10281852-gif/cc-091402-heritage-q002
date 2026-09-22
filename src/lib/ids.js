import { randomUUID } from "node:crypto";

export function newId(prefix) {
  return `${prefix}_${randomUUID()}`;
}
