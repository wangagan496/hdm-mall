import type { Accounts } from '../../src/accounts.ts'
import { AppError } from '../../src/errors.ts'

export function identityHeaders(accounts: Accounts, token: string) {
  const authorization = `Bearer ${token}`
  try {
    const { identity, identityRevision } = accounts.authenticate(authorization)
    return { authorization, 'x-hdm-identity': identity, 'x-hdm-identity-revision': String(identityRevision) }
  } catch (error) {
    if (!(error instanceof AppError) || error.statusCode !== 401) throw error
    // The HTTP assertion must still exercise the expired or invalid bearer token.
    return { authorization, 'x-hdm-identity': 'buyer', 'x-hdm-identity-revision': '0' }
  }
}
