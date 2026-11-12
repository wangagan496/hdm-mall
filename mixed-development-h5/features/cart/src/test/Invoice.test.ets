import { describe, it, expect } from '@ohos/hypium'
import { normalizedInvoice, invoiceInputError } from 'models'

export default function invoiceTest() {
  describe('Invoice', () => {
    it('companyRequiresTaxId', 0, () => {
      expect(invoiceInputError({ titleType: 'company', title: '单位', email: 'me@example.test' })).assertContain('税号')
    })
    it('normalizesCompanyFields', 0, () => {
      const value = normalizedInvoice({ titleType: 'company', title: ' 单位 ', taxId: '91310000123456789a', email: ' me@example.test ' })
      expect(value.title).assertEqual('单位')
      expect(value.taxId).assertEqual('91310000123456789A')
      expect(value.email).assertEqual('me@example.test')
      expect(invoiceInputError(value)).assertEqual('')
    })
    it('individualDropsOldTaxId', 0, () => {
      expect(normalizedInvoice({ titleType: 'individual', title: '个人', taxId: 'invalid', email: 'me@example.test' }).taxId === undefined).assertTrue()
    })
    it('rejectsEmptyTitleAndInvalidEmail', 0, () => {
      expect(invoiceInputError({ titleType: 'individual', title: ' ', email: 'me@example.test' })).assertContain('抬头')
      expect(invoiceInputError({ titleType: 'individual', title: '个人', email: 'invalid' })).assertContain('邮箱')
    })
  })
}
