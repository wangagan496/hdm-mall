import { QuoteResponse, QuoteLine, QuoteReason } from 'models'
import { quoteComparisonText } from '../utils/QuotePreview'

@Component
export struct QuotePanel {
  @Prop quote: QuoteResponse | null = null
  @Prop busy: boolean = false
  @Prop error: string = ''
  @Link expanded: boolean
  onRetry: () => void = () => {}
  build() {
    Column({ space: 6 }) {
      if (this.busy) { Text('正在读取精确报价…').fontSize(13).fontColor($r('[ui_components].color.black')) }
      if (this.error) {
        Text('报价未完成：' + this.error).id('quote-error').fontSize(14).fontColor($r('[ui_components].color.red')).width('100%')
        Button('重试报价').id('quote-retry').fontSize(13).fontColor($r('[ui_components].color.black'))
          .backgroundColor($r('[ui_components].color.under')).onClick(() => this.onRetry())
        Text('可继续核对商品和地址，下单仍由服务端重新校验。').fontSize(12).fontColor($r('[ui_components].color.gray'))
      }
      if (this.quote) {
        Text(quoteComparisonText(this.quote)).id('quote-comparison').fontSize(14).fontWeight(500)
          .fontColor(this.quote.comparison && (this.quote.comparison.deltaCents !== 0 || this.quote.comparison.reasons.length > 0) ? $r('[ui_components].color.red') : $r('[ui_components].color.black')).width('100%')
        if (this.quote.comparison) {
          ForEach(this.quote.comparison.reasons, (reason: QuoteReason) => {
            Text(reason.message).id('quote-reason-' + reason.kind).fontSize(13).fontColor($r('[ui_components].color.red')).width('100%')
          }, (reason: QuoteReason) => reason.kind + ':' + reason.skuId)
        }
        Text('实付 ¥' + (this.quote.amountCents / 100).toFixed(2) + (this.expanded ? ' · 收起明细' : ' · 点开明细'))
          .id('quote-total').fontSize(16).fontColor($r('[ui_components].color.black')).width('100%').padding({ top: 6, bottom: 6 })
          .onClick(() => { this.expanded = !this.expanded })
        if (this.quote.promotion.rule.enabled && this.quote.promotion.remainingCents > 0) {
          Text('还差 ' + (this.quote.promotion.remainingCents / 100).toFixed(2) + ' 元可满减').id('quote-remaining')
            .fontSize(13).fontColor($r('[ui_components].color.gray')).width('100%')
        }
        if (this.expanded) {
          ForEach(this.quote.lines, (line: QuoteLine) => {
            Text(line.productName + ' ' + line.spec + ' ¥' + (line.unitPriceCents / 100).toFixed(2) + ' × ' + line.count + ' = ¥' + (line.subtotalCents / 100).toFixed(2))
              .id('quote-line-' + line.skuId).fontSize(13).fontColor($r('[ui_components].color.black')).width('100%')
            Text('价格依据：商品第 ' + line.productRevision + ' 版').fontSize(11).fontColor($r('[ui_components].color.gray')).width('100%')
          }, (line: QuoteLine) => line.skuId)
          Text('满减（规则第 ' + this.quote.promotion.rule.revision + ' 版）−¥' + (this.quote.promotion.appliedDiscountCents / 100).toFixed(2))
            .id('quote-promotion-rule').fontSize(13).fontColor($r('[ui_components].color.black')).width('100%')
        }
      }
    }.width('100%').padding(12).backgroundColor($r('[ui_components].color.white')).borderRadius(10)
  }
}
