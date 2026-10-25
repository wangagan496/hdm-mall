export class AppError extends Error {
  statusCode: number
  constructor(status: number, message: string) { super(message); this.statusCode = status }
}
export function ensure(condition: unknown, status: number, message: string): asserts condition {
  if (!condition) throw new AppError(status, message)
}
