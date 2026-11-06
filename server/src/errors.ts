export class AppError extends Error {
  statusCode: number
  reason?: string
  data?: unknown
  constructor(status: number, message: string, reason?: string, data?: unknown) {
    super(message); this.statusCode = status; this.reason = reason; this.data = data
  }
}
export function ensure(condition: unknown, status: number, message: string): asserts condition {
  if (!condition) throw new AppError(status, message)
}
