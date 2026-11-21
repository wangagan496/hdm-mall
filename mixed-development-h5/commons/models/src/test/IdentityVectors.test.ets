// 生成文件勿手改；与 Node/TS 共用 contract-kit/v1/vectors/identity-context.ts
import { describe, it, expect } from '@ohos/hypium'
import { parseIdentityContext, parseIdentitySwitch, parseIdentityLayout, parseIdentityLayoutUpdate } from '../main/ets/IdentityContext'
export default function identityVectorTests(): void {
  describe('identityContractVectors', () => {
    it('buyer context', 0, () => { expect(parseIdentityContext("{\"identity\":\"buyer\",\"identities\":[\"buyer\"],\"identityRevision\":0}") !== null).assertEqual(true) })
    it('switched context', 0, () => { expect(parseIdentityContext("{\"identity\":\"merchant\",\"identities\":[\"merchant\",\"buyer\"],\"identityRevision\":4}") !== null).assertEqual(true) })
    it('no grants', 0, () => { expect(parseIdentityContext("{\"identity\":\"buyer\",\"identities\":[],\"identityRevision\":0}") !== null).assertEqual(false) })
    it('unknown grant', 0, () => { expect(parseIdentityContext("{\"identity\":\"buyer\",\"identities\":[\"buyer\",\"admin\"],\"identityRevision\":0}") !== null).assertEqual(false) })
    it('legacy role field', 0, () => { expect(parseIdentityContext("{\"identity\":\"buyer\",\"identities\":[\"buyer\"],\"identityRevision\":0,\"role\":\"buyer\"}") !== null).assertEqual(false) })
    it('unsafe context revision', 0, () => { expect(parseIdentityContext("{\"identity\":\"buyer\",\"identities\":[\"buyer\"],\"identityRevision\":9007199254740992}") !== null).assertEqual(false) })
    it('switch to buyer', 0, () => { expect(parseIdentitySwitch("{\"identity\":\"buyer\"}") !== null).assertEqual(true) })
    it('switch to merchant', 0, () => { expect(parseIdentitySwitch("{\"identity\":\"merchant\"}") !== null).assertEqual(true) })
    it('unknown identity', 0, () => { expect(parseIdentitySwitch("{\"identity\":\"processor\"}") !== null).assertEqual(false) })
    it('injected account', 0, () => { expect(parseIdentitySwitch("{\"identity\":\"merchant\",\"userId\":\"x\"}") !== null).assertEqual(false) })
    it('saved layout', 0, () => { expect(parseIdentityLayout("{\"identity\":\"merchant\",\"hiddenEntries\":[\"merchant-products\"],\"revision\":1}") !== null).assertEqual(true) })
    it('negative layout revision', 0, () => { expect(parseIdentityLayout("{\"identity\":\"merchant\",\"hiddenEntries\":[\"merchant-products\"],\"revision\":-1}") !== null).assertEqual(false) })
    it('layout update', 0, () => { expect(parseIdentityLayoutUpdate("{\"hiddenEntries\":[\"favorites\"],\"expectedRevision\":0}") !== null).assertEqual(true) })
    it('reset layout', 0, () => { expect(parseIdentityLayoutUpdate("{\"hiddenEntries\":[],\"expectedRevision\":0}") !== null).assertEqual(true) })
    it('fractional revision', 0, () => { expect(parseIdentityLayoutUpdate("{\"hiddenEntries\":[\"favorites\"],\"expectedRevision\":0.1}") !== null).assertEqual(false) })
    it('empty entry id', 0, () => { expect(parseIdentityLayoutUpdate("{\"hiddenEntries\":[\"\"],\"expectedRevision\":0}") !== null).assertEqual(false) })
    it('too many entries', 0, () => { expect(parseIdentityLayoutUpdate("{\"hiddenEntries\":[\"favorites\",\"favorites\",\"favorites\",\"favorites\",\"favorites\",\"favorites\",\"favorites\",\"favorites\",\"favorites\",\"favorites\",\"favorites\",\"favorites\",\"favorites\",\"favorites\",\"favorites\",\"favorites\",\"favorites\"],\"expectedRevision\":0}") !== null).assertEqual(false) })
    it('injected layout identity', 0, () => { expect(parseIdentityLayoutUpdate("{\"hiddenEntries\":[\"favorites\"],\"expectedRevision\":0,\"identity\":\"merchant\"}") !== null).assertEqual(false) })
  })
}
