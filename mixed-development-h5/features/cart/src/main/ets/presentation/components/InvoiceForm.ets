import { InvoiceInput } from 'models'

@Component
export struct InvoiceForm {
  @Prop value: InvoiceInput = { titleType: 'individual', title: '', email: '' }
  @Prop disabled: boolean = false
  onChange: (value: InvoiceInput) => void = () => {}

  build() {
    Column({ space: 10 }) {
      Text('发票由商家线下开具，开具后会在订单中标记').fontSize(13).fontColor($r('[ui_components].color.gray'))
      Row({ space: 12 }) {
        Button('个人').id('invoice-individual').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red'))
          .border({ width: this.value.titleType === 'individual' ? 2 : 0, color: $r('[ui_components].color.red') })
          .onClick(() => this.onChange({ titleType: 'individual', title: this.value.title, email: this.value.email }))
        Button('单位').id('invoice-company').backgroundColor($r('[ui_components].color.white')).fontColor($r('[ui_components].color.red'))
          .border({ width: this.value.titleType === 'company' ? 2 : 0, color: $r('[ui_components].color.red') })
          .onClick(() => this.onChange({ titleType: 'company', title: this.value.title, taxId: '', email: this.value.email }))
      }
      Text('发票抬头').fontSize(13).fontColor($r('[ui_components].color.text'))
      TextInput({ text: this.value.title, placeholder: this.value.titleType === 'company' ? '单位名称' : '个人姓名' }).id('invoice-title').maxLength(100)
        .fontColor($r('[ui_components].color.text')).backgroundColor($r('[ui_components].color.under'))
        .onChange(text => this.onChange({ titleType: this.value.titleType, title: text, taxId: this.value.taxId, email: this.value.email }))
      if (this.value.titleType === 'company') {
        Text('单位税号').fontSize(13).fontColor($r('[ui_components].color.text'))
        TextInput({ text: this.value.taxId || '', placeholder: '必填，15 到 20 位' }).id('invoice-tax-id').maxLength(20)
          .fontColor($r('[ui_components].color.text')).backgroundColor($r('[ui_components].color.under'))
          .onChange(text => this.onChange({ titleType: this.value.titleType, title: this.value.title, taxId: text, email: this.value.email }))
      }
      Text('接收邮箱').fontSize(13).fontColor($r('[ui_components].color.text'))
      TextInput({ text: this.value.email, placeholder: '发票会发到这个邮箱' }).id('invoice-email').maxLength(254).type(InputType.Email)
        .fontColor($r('[ui_components].color.text')).backgroundColor($r('[ui_components].color.under'))
        .onChange(text => this.onChange({ titleType: this.value.titleType, title: this.value.title, taxId: this.value.taxId, email: text }))
    }.width('100%').alignItems(HorizontalAlign.Start).enabled(!this.disabled)
  }
}
