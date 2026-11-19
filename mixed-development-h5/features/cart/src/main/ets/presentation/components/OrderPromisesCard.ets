import { OrderSku, PromiseEntry, PromiseSnapshot, parsePromiseSnapshot } from 'models'

@Component
export struct OrderPromisesCard {
  @Prop @Watch('readSnapshot') sku: OrderSku
  @Prop canCheck: boolean = false
  @Prop busy: boolean = false
  onCheck: (skuId: string, fieldId: string, result: string) => void = () => {}
  @State snapshot: PromiseSnapshot | null = null

  aboutToAppear(): void { this.readSnapshot() }

  private readSnapshot(): void {
    this.snapshot = this.sku.promiseSnapshot ? parsePromiseSnapshot(JSON.stringify(this.sku.promiseSnapshot)) : null
  }

  private checked(fieldId: string): string {
    return this.sku.promiseChecks?.find(item => item.fieldId === fieldId)?.result || ''
  }

  private value(entry: PromiseEntry): string {
    if (entry.status === 'not-applicable') return '不适用'
    if (entry.status === 'unknown') return '商家未说明'
    return (entry.value || '') + (entry.unit || '')
  }

  build() {
    Column({ space: 8 }) {
      Text(this.sku.name + (this.sku.attrsText ? ' · ' + this.sku.attrsText : ''))
        .fontSize(15).fontWeight(FontWeight.Medium).fontColor($r('[ui_components].color.text')).width('100%')
      if (this.snapshot) {
        ForEach(this.snapshot.entries, (entry: PromiseEntry) => {
          Column({ space: 6 }) {
            Text(entry.label + '：' + this.value(entry)).id('order-promise-value-' + this.sku.id + '-' + entry.fieldId)
              .fontSize(14).fontColor($r('[ui_components].color.text')).width('100%')
            if (entry.condition) {
              Text('适用条件：' + entry.condition).fontSize(13).fontColor($r('[ui_components].color.text')).width('100%')
            }
            if (entry.conditionNeedsReview) {
              Text('请看原文核对').id('order-promise-condition-review-' + this.sku.id + '-' + entry.fieldId)
                .fontSize(13).fontColor($r('[ui_components].color.text')).width('100%')
            }
            if (entry.quote) {
              Text('商品资料原文：' + entry.quote).fontSize(13).fontColor($r('[ui_components].color.gray')).width('100%')
            }
            if (this.checked(entry.fieldId)) {
              Text(this.checked(entry.fieldId) === 'matches' ? '已核对：符合' : '已核对：不符')
                .id('order-promise-checked-' + this.sku.id + '-' + entry.fieldId)
                .fontSize(13).fontColor($r('[ui_components].color.text')).width('100%')
            }
            if (this.canCheck && entry.status === 'known') {
              Row({ space: 8 }) {
                Button('符合').id('order-promise-matches-' + this.sku.id + '-' + entry.fieldId)
                  .backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.text'))
                  .enabled(!this.busy).onClick(() => this.onCheck(this.sku.id, entry.fieldId, 'matches'))
                Button('不符').id('order-promise-mismatch-' + this.sku.id + '-' + entry.fieldId)
                  .backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.red'))
                  .enabled(!this.busy).onClick(() => this.onCheck(this.sku.id, entry.fieldId, 'mismatch'))
              }.width('100%')
            }
          }.width('100%').alignItems(HorizontalAlign.Start)
        }, (entry: PromiseEntry) => entry.fieldId + ':' + this.checked(entry.fieldId))
      } else if (this.sku.promiseSnapshot) {
        Text('下单承诺暂未读到，请刷新订单').fontColor($r('[ui_components].color.gray')).width('100%')
      } else {
        Text('下单时无已发布承诺').id('order-promises-none-' + this.sku.id)
          .fontColor($r('[ui_components].color.gray')).width('100%')
      }
    }.width('100%').alignItems(HorizontalAlign.Start).padding({ top: 6, bottom: 6 })
  }
}
