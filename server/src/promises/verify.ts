import { z } from 'zod'
import type { PromiseEntry, PromiseSourceField, PromiseUnit } from './generated.ts'
import { promiseCatalog } from './templates/catalog.ts'

export const SOURCE_FIELDS = ['name', 'description', 'imageText', 'specifications'] as const
export type Template = (typeof promiseCatalog)[number]
export interface MaterialText { id: string; version: number; text: string }
export type Sources = Record<Exclude<PromiseSourceField, 'material'>, string> & { materials?: MaterialText[] }

const candidatesSchema = z.object({ claims: z.array(z.unknown()).max(24) }).strict()
const candidateSchema = z.object({
  fieldId: z.string().min(1).max(100), source: z.enum([...SOURCE_FIELDS, 'material']),
  materialId: z.string().min(1).max(100).optional(),
  quote: z.string().min(1).max(250), value: z.string().min(1).max(250),
  unit: z.string().min(1).max(20).nullable(), condition: z.string().min(1).max(250).nullable(),
}).strict()
export type Candidate = z.infer<typeof candidateSchema>

export function matchesCategory(template: Template, category: string): boolean {
  return (template.categories as readonly string[]).some(value => value === '*' || value === category)
}

export const sentenceSeparator = /[。！？!?；;\r\n]/u
const instructions = /忽略|无视|不遵守|越过|忽视|此前.{0,10}(?:规则|指令)|提示词|系统(?:指令|规则|消息)|(?:输出|回答|返回|生成)\s*[:：]?|(?:ignore|disregard|override).{0,30}(?:previous|instruction|rule|system)|(?:prompt|system message)\s*[:：]/iu
const amount = /^(?:[0-9]+(?:\.[0-9]+)?|[零〇一二两三四五六七八九十百千点]+)$/u
const denial = /不(?:包邮|免邮|含|包含|包括|赠|附赠|送赠品|承担|适用|发货|退换|退货|换货|支持|接受|参与|提供|承诺|保证|予|得|是)|不可|不能|并非|未(?:承诺|提供)|无(?:赠品|保修)|概不/u
const exceptions = /(?<![去清])除[^，,；;]{1,60}外|[^，,；;]{0,60}(?:除外|例外)/gu
const restriction = /未(?:拆封|开封|启封|穿|使用|激活|签收)|仅(?:限|供|适用)|只(?:限|能)|限于|(?<![无免不])(?:需|须)|自[^，,]{1,15}起|(?:付款|收货|签收)后|满\s*(?:\d|[零〇一二两三四五六七八九十百千])/u

function sentenceAt(text: string, start: number, end: number): string {
  while (start > 0 && !sentenceSeparator.test(text[start - 1])) start--
  while (end < text.length && !sentenceSeparator.test(text[end])) end++
  return text.slice(start, end).trim()
}

function missingEntry(template: Template, category: string): PromiseEntry {
  return {
    fieldId: template.id, label: template.label,
    status: matchesCategory(template, category) ? 'unknown' : 'not-applicable',
    value: null, unit: null, condition: null, quote: null, sourceRef: null, sourceRevision: null,
  }
}

function verifiedCandidate(candidate: Candidate, template: Template, sourceText: string, revision: number):
{ entry: PromiseEntry; warning: string } | string {
  const { quote, value, unit, condition } = candidate
  const start = sourceText.indexOf(quote)
  if (start < 0 || !value.trim() || !quote.includes(value)) return '候选值或摘录与原文不符'
  const end = start + quote.length
  if (sourceText.indexOf(quote, start + 1) >= 0) return '原文中有多处相同文字，无法定位这条承诺'
  const sentence = sentenceAt(sourceText, start, end - Number(sentenceSeparator.test(quote[quote.length - 1])))
  // A substring of an instruction or a negated statement is never a standalone claim.
  if (instructions.test(sentence)) return '原文含有要求模型输出的指令'
  if (!sentence || sentence !== quote.trim().replace(/[。！？!?；;]$/u, '').trim()) return '候选摘录未保留完整原句'
  const clauses = sentence.split(/[，,、]/u)
  const claimClauses = clauses.filter(clause => clause.includes(value))
  const containsDenial = claimClauses.length ? claimClauses.some(clause => denial.test(clause)) : denial.test(sentence)
  if (containsDenial) return '原文含有否定说明，不能作为正面承诺'
  const otherDeniedClauses = clauses.filter(clause => !clause.includes(value) && denial.test(clause))
  const hasCue = (template.cues as readonly string[]).some(cue => quote.includes(cue))
  if (!hasCue && !(template.id === 'specification' && candidate.source === 'specifications')) return '原文未明确说明此项承诺'

  if (template.valueType === 'number') {
    if (!unit || !(template.units as readonly string[]).includes(unit)) return '单位不在此项允许范围内'
    if (!amount.test(value) || !containsExactAmount(quote, value, unit)) return '数字和单位与原文不符'
  } else if (unit !== null) return '此项不使用计量单位'

  const grounded = condition?.trim() && quote.includes(condition) ? condition.trim() : null
  const exceptionMatches = [...sentence.matchAll(exceptions)].map(match => match[0])
  const groundedCondition = grounded
  const restrictionMatches = [...sentence.matchAll(new RegExp(restriction.source, 'gu'))].map(match => match[0])
  const omittedRestriction = [...restrictionMatches, ...exceptionMatches, ...otherDeniedClauses]
    .some(match => !groundedCondition?.includes(match))
  const warning = condition !== null && groundedCondition === null
    ? '适用条件未能逐字对上原文，请看原文核对'
    : omittedRestriction ? '原文有适用限制，请看原文核对' : ''
  return {
    entry: {
      fieldId: template.id, label: template.label, status: 'known', value, unit: unit as PromiseUnit | null,
      condition: groundedCondition, quote, sourceRef: { field: candidate.source, start, end,
        ...(candidate.materialId ? { materialId: candidate.materialId } : {}) }, sourceRevision: revision,
      ...(warning ? { conditionNeedsReview: true } : {}),
      ...(template.suggestedAfterSaleKind ? { suggestedAfterSaleKind: template.suggestedAfterSaleKind } : {}),
    },
    warning,
  }
}

function containsExactAmount(quote: string, value: string, unit: string): boolean {
  const numbers = quote.matchAll(/([0-9]+(?:\.[0-9]+)?|[零〇一二两三四五六七八九十百千点]+)\s*(小时|工作日|个月|天|周|月|年)/gu)
  // Ambiguous durations have to be split into independently verifiable source sentences.
  const found = [...numbers]
  return found.length === 1 && found[0][1] === value && found[0][2] === unit
}

export function verifyPromiseCandidates(content: string, input: {
  category: string; revision: number; name: string; description: string; specifications?: string; imageText?: string; materials?: MaterialText[]
}): { entries: PromiseEntry[]; issues: string[] } {
  const draft = candidatesSchema.parse(JSON.parse(content))
  const { category, revision } = input
  const issues: string[] = []
  const verified = new Map<string, PromiseEntry>()
  const conflicts = new Set<string>()
  for (const raw of draft.claims) {
    const parsed = candidateSchema.safeParse(raw)
    if (!parsed.success) {
      issues.push('有一条候选的字段、来源或格式不符合要求')
      continue
    }
    const candidate = parsed.data
    const template = promiseCatalog.find(field => field.id === candidate.fieldId)
    if (!template || !matchesCategory(template, category)) {
      issues.push('有一条候选不属于当前品类允许的字段')
      continue
    }
    const material = candidate.source === 'material' ? input.materials?.find(row => row.id === candidate.materialId) : undefined
    if (candidate.source === 'material' ? !material : !!candidate.materialId) {
      issues.push('有一条候选引用了无法核对的来源材料')
      continue
    }
    const sourceText = candidate.source === 'material' ? material!.text : input[candidate.source] ?? ''
    const result = verifiedCandidate(candidate, template, sourceText, material?.version ?? revision)
    if (typeof result === 'string') {
      issues.push(`${template.label}：${result}`)
      continue
    }
    if (conflicts.has(template.id)) continue
    const { entry, warning } = result
    const previous = verified.get(template.id)
    if (previous && (previous.value !== entry.value || previous.unit !== entry.unit || previous.condition !== entry.condition || previous.quote !== entry.quote)) {
      issues.push(`${template.label}：同一项候选存在冲突`)
      verified.delete(template.id)
      conflicts.add(template.id)
      continue
    }
    if (!previous || (warning && !previous.conditionNeedsReview)) {
      verified.set(template.id, entry)
      if (warning) issues.push(template.label + '：' + warning)
    }
  }
  return { entries: promiseCatalog.map(template => verified.get(template.id) ?? missingEntry(template, category)), issues }
}
