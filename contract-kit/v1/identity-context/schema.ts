import { z } from '../../../server/node_modules/zod/index.js'

export const IdentitySchema = z.enum(['buyer', 'merchant'])
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const entryId = z.string().min(1).max(64)
const hiddenEntries = z.array(entryId).max(16)

export const identitySchemas = {
  IdentityContext: z.object({
    identity: IdentitySchema,
    identities: z.array(IdentitySchema).min(1).max(2),
    identityRevision: revision
  }).strict(),
  IdentitySwitch: z.object({ identity: IdentitySchema }).strict(),
  IdentityLayout: z.object({ identity: IdentitySchema, hiddenEntries, revision }).strict(),
  IdentityLayoutUpdate: z.object({ hiddenEntries, expectedRevision: revision }).strict()
}
