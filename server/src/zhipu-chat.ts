import { z } from 'zod'

export const ZHIPU_MODEL = 'glm-5.3-flash'
export const PROMISE_OUTPUT_TOKENS = 1024
export type PromiseModelMessage = { role: 'system' | 'user'; content: string }
export type PromiseModelResult = (
  | { status: 'completed'; content: string; tokens: number | null }
  | { status: 'quota-exhausted' | 'timeout' | 'failed'; tokens: number | null }
) & { providerHttpStatus?: number; providerErrorCode?: string }

const usage = z.object({ total_tokens: z.number().int().nonnegative() })
const completion = z.object({
  model: z.literal(ZHIPU_MODEL),
  choices: z.array(z.object({ message: z.object({ content: z.string().trim().min(1).max(16000) }),
    finish_reason: z.literal('stop').optional(), })).length(1),
})
const providerError = z.object({ error: z.object({ code: z.union([z.string(), z.number()]) }) })
// https://docs.bigmodel.cn/cn/api/api-code.md
const quotaCodes = new Set(['1113', '1308', '1309', '1310', '1314', '1316', '1317', '1318', '1319', '1320', '1321'])

export async function completeWithZhipu(
  apiKey: string,
  messages: ReadonlyArray<PromiseModelMessage>,
  signal: AbortSignal,
): Promise<PromiseModelResult> {
  try {
    const response = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ZHIPU_MODEL, messages, stream: false, max_tokens: PROMISE_OUTPUT_TOKENS,
        // GLM-5.3-Flash only supports enabled thinking.
        thinking: { type: 'enabled' }, reasoning_effort: 'low', response_format: { type: 'json_object' },
      }),
    })
    const result: unknown = await response.json().catch(() => null)
    const providerHttpStatus = response.status
    if (signal.aborted) return { status: 'timeout', tokens: null, providerHttpStatus }
    const parsedUsage = usage.safeParse((result as { usage?: unknown } | null)?.usage)
    const tokens = parsedUsage.success ? parsedUsage.data.total_tokens : null
    const error = providerError.safeParse(result)
    const code = error.success ? String(error.data.error.code) : ''
    const providerErrorCode = /^\d{4}$/.test(code) ? code : undefined
    if (quotaCodes.has(code)) return { status: 'quota-exhausted', tokens, providerHttpStatus, providerErrorCode }
    if (!response.ok || error.success) return { status: 'failed', tokens, providerHttpStatus, providerErrorCode }
    const parsed = completion.safeParse(result)
    if (!parsed.success) return { status: 'failed', tokens, providerHttpStatus }
    return { status: 'completed', content: parsed.data.choices[0].message.content, tokens, providerHttpStatus }
  } catch {
    return { status: signal.aborted ? 'timeout' : 'failed', tokens: null }
  }
}
