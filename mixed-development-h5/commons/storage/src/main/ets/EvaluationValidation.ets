// 真实订单与本地演示共用的内容规则，与存储方式无关。
export function validateEvaluation(score: number, content: string): string | null {
  if (!Number.isInteger(score) || score < 1 || score > 5) return '请给出 1-5 星评分'
  const length: number = content.trim().length
  if (length < 5) return '评价内容至少 5 个字'
  if (length > 200) return '评价内容不能超过 200 个字'
  return null
}
