// 生成文件勿手改；来源 contract-kit/v1/identity-context/schema.ts
export type Identity = "buyer" | "merchant"
export interface IdentityContext {
  identity: Identity
  identities: Identity[]
  identityRevision: number
}
export interface IdentitySwitch {
  identity: Identity
}
export interface IdentityLayout {
  identity: Identity
  hiddenEntries: string[]
  revision: number
}
export interface IdentityLayoutUpdate {
  hiddenEntries: string[]
  expectedRevision: number
}
function validIdentityContext(value: Object | null | undefined): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as IdentityContext
  if (Object.keys(row).some((key: string) => ["identity","identities","identityRevision"].indexOf(key) < 0)) return false
  return (typeof row.identity === 'string' && ["buyer","merchant"].indexOf(row.identity) >= 0) &&
    (Array.isArray(row.identities) && row.identities.length >= 1 && row.identities.length <= 2 && row.identities.every((item: Identity) => (typeof item === 'string' && ["buyer","merchant"].indexOf(item) >= 0))) &&
    (typeof row.identityRevision === 'number' && Number.isSafeInteger(row.identityRevision) && row.identityRevision >= 0 && row.identityRevision <= 9007199254740991)
}
export function parseIdentityContext(text: string): IdentityContext | null {
  try { const value = JSON.parse(text) as IdentityContext; return validIdentityContext(value) ? value : null } catch { return null }
}
function validIdentitySwitch(value: Object | null | undefined): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as IdentitySwitch
  if (Object.keys(row).some((key: string) => ["identity"].indexOf(key) < 0)) return false
  return (typeof row.identity === 'string' && ["buyer","merchant"].indexOf(row.identity) >= 0)
}
export function parseIdentitySwitch(text: string): IdentitySwitch | null {
  try { const value = JSON.parse(text) as IdentitySwitch; return validIdentitySwitch(value) ? value : null } catch { return null }
}
function validIdentityLayout(value: Object | null | undefined): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as IdentityLayout
  if (Object.keys(row).some((key: string) => ["identity","hiddenEntries","revision"].indexOf(key) < 0)) return false
  return (typeof row.identity === 'string' && ["buyer","merchant"].indexOf(row.identity) >= 0) &&
    (Array.isArray(row.hiddenEntries) && row.hiddenEntries.length <= 16 && row.hiddenEntries.every((item: string) => (typeof item === 'string' && item.length >= 1 && item.length <= 64))) &&
    (typeof row.revision === 'number' && Number.isSafeInteger(row.revision) && row.revision >= 0 && row.revision <= 9007199254740991)
}
export function parseIdentityLayout(text: string): IdentityLayout | null {
  try { const value = JSON.parse(text) as IdentityLayout; return validIdentityLayout(value) ? value : null } catch { return null }
}
function validIdentityLayoutUpdate(value: Object | null | undefined): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as IdentityLayoutUpdate
  if (Object.keys(row).some((key: string) => ["hiddenEntries","expectedRevision"].indexOf(key) < 0)) return false
  return (Array.isArray(row.hiddenEntries) && row.hiddenEntries.length <= 16 && row.hiddenEntries.every((item: string) => (typeof item === 'string' && item.length >= 1 && item.length <= 64))) &&
    (typeof row.expectedRevision === 'number' && Number.isSafeInteger(row.expectedRevision) && row.expectedRevision >= 0 && row.expectedRevision <= 9007199254740991)
}
export function parseIdentityLayoutUpdate(text: string): IdentityLayoutUpdate | null {
  try { const value = JSON.parse(text) as IdentityLayoutUpdate; return validIdentityLayoutUpdate(value) ? value : null } catch { return null }
}
