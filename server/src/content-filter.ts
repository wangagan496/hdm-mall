import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { ensure } from './errors.ts'

const words = z.array(z.string().min(2)).min(1).parse(JSON.parse(readFileSync(new URL('./moderation-words.json', import.meta.url), 'utf8')))
export function checkPublicContent(value: string) {
  const normalized = value.normalize('NFKC').replace(/[\s\u200b-\u200d\ufeff]/gu, '').toLowerCase()
  ensure(!words.some(word => normalized.includes(word.normalize('NFKC').toLowerCase())), 400, '内容包含不适合发布的词，请修改后再发布')
}
