/**
 * 订单评价页的展示口径：星级文案、快捷标签、标签写入评价内容。
 * 校验长度仍以 DemoOrderStore.validateEvaluation 为准，这里只处理 UI 拼装。
 */

export const EVALUATION_CONTENT_MAX_LENGTH: number = 200

export function getScoreLabel(score: number): string {
  if (score === 1) {
    return '非常差'
  }
  if (score === 2) {
    return '差'
  }
  if (score === 3) {
    return '一般'
  }
  if (score === 4) {
    return '好'
  }
  if (score === 5) {
    return '非常好'
  }
  return ''
}

export function getEvaluationQuickTags(): string[] {
  return ['质量非常好', '物流速度很快', '尺码很合适', '性价比很高', '包装很严实', '和描述相符']
}

export function hasEvaluationTag(content: string, tag: string): boolean {
  return content.indexOf(tag) >= 0
}

export function toggleEvaluationTag(content: string, tag: string, maxLength: number): string {
  if (!tag) {
    return content
  }
  const index: number = content.indexOf(tag)
  if (index >= 0) {
    const before: string = content.substring(0, index)
    const after: string = content.substring(index + tag.length)
    return collapseSpaces(before + after)
  }
  const prefix: string = content.trim()
  const next: string = prefix.length === 0 ? tag : prefix + ' ' + tag
  if (next.length > maxLength) {
    return content
  }
  return next
}

function collapseSpaces(value: string): string {
  let result: string = value
  while (result.indexOf('  ') >= 0) {
    result = result.replace('  ', ' ')
  }
  return result.trim()
}
