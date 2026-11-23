type IdentityVector = {
  name: string
  kind: 'IdentityContext' | 'IdentitySwitch' | 'IdentityLayout' | 'IdentityLayoutUpdate'
  value: unknown
  valid: boolean
}

const buyer = { identity: 'buyer', identities: ['buyer'], identityRevision: 0 }
const switched = { identity: 'merchant', identities: ['merchant', 'buyer'], identityRevision: 4 }
const layout = { identity: 'merchant', hiddenEntries: ['merchant-products'], revision: 1 }
const update = { hiddenEntries: ['favorites'], expectedRevision: 0 }

export const identityVectors: IdentityVector[] = [
  { name: 'buyer context', kind: 'IdentityContext', value: buyer, valid: true },
  { name: 'switched context', kind: 'IdentityContext', value: switched, valid: true },
  { name: 'no grants', kind: 'IdentityContext', value: { ...buyer, identities: [] }, valid: false },
  { name: 'unknown grant', kind: 'IdentityContext', value: { ...buyer, identities: ['buyer', 'admin'] }, valid: false },
  { name: 'legacy role field', kind: 'IdentityContext', value: { ...buyer, role: 'buyer' }, valid: false },
  { name: 'unsafe context revision', kind: 'IdentityContext', value: { ...buyer, identityRevision: 2 ** 53 }, valid: false },
  { name: 'switch to buyer', kind: 'IdentitySwitch', value: { identity: 'buyer' }, valid: true },
  { name: 'switch to merchant', kind: 'IdentitySwitch', value: { identity: 'merchant' }, valid: true },
  { name: 'unknown identity', kind: 'IdentitySwitch', value: { identity: 'processor' }, valid: false },
  { name: 'injected account', kind: 'IdentitySwitch', value: { identity: 'merchant', userId: 'x' }, valid: false },
  { name: 'saved layout', kind: 'IdentityLayout', value: layout, valid: true },
  { name: 'negative layout revision', kind: 'IdentityLayout', value: { ...layout, revision: -1 }, valid: false },
  { name: 'layout update', kind: 'IdentityLayoutUpdate', value: update, valid: true },
  { name: 'reset layout', kind: 'IdentityLayoutUpdate', value: { ...update, hiddenEntries: [] }, valid: true },
  { name: 'fractional revision', kind: 'IdentityLayoutUpdate', value: { ...update, expectedRevision: 0.1 }, valid: false },
  { name: 'empty entry id', kind: 'IdentityLayoutUpdate', value: { ...update, hiddenEntries: [''] }, valid: false },
  { name: 'too many entries', kind: 'IdentityLayoutUpdate', value: { ...update, hiddenEntries: Array<string>(17).fill('favorites') }, valid: false },
  { name: 'injected layout identity', kind: 'IdentityLayoutUpdate', value: { ...update, identity: 'merchant' }, valid: false }
]
