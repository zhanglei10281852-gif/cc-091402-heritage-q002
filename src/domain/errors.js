/** 业务校验错误，映射为 4xx；其它错误按 500 处理 */
export class DomainError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

export const Errors = {
  notFound: (resource, id) =>
    new DomainError("not_found", `${resource} 不存在：${id}`, 404),
  conflict: (code, message, details) => new DomainError(code, message, 409, details),
  unprocessable: (code, message, details) =>
    new DomainError(code, message, 422, details),
  forbidden: (code, message) => new DomainError(code, message, 403),
};
