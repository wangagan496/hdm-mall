export function reconciliationDay(time: number): string {
  return new Date(time + 8 * 3600000).toISOString().slice(0, 10)
}
export function validReconciliationDate(date: string): boolean {
  const time: number = Date.parse(date + 'T00:00:00+08:00')
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(time) && reconciliationDay(time) === date
}
