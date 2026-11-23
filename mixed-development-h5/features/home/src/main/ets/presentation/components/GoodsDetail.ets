import { Goods } from '../../domain/models'
import { PromiseEntry, parsePromiseSnapshot } from 'models'
import { PromiseSourcePanel } from 'ui_components'
import { missingSizeChartText } from '../../data/api/goodsPresentation'

@Component
export struct GoodsDetail {
  @Prop goods: Goods = {} as Goods

  getDetailPictures(): string[] {
    if (!this.goods || !this.goods.details || !this.goods.details.pictures) {
      return []
    }
    return this.goods.details.pictures
  }

  private publishedEntries(): PromiseEntry[] {
    const raw = this.goods.promiseSnapshot
    const snapshot = raw ? parsePromiseSnapshot(JSON.stringify(raw)) : null
    return snapshot?.entries.filter(entry => entry.status === 'known') ?? []
  }

  @Builder
  private Sizing(entries: PromiseEntry[]) {
    Column({ space: 6 }) {
      Text('尺码与版型').id('goods-sizing').fontSize(16).fontWeight(FontWeight.Medium)
        .fontColor($r('[ui_components].color.text'))
      ForEach(entries.filter(entry => entry.fieldId === 'size-chart'), (entry: PromiseEntry) => {
        Text(entry.value || '').id('goods-size-chart').fontSize(14).fontColor($r('[ui_components].color.text'))
        if (entry.conditionNeedsReview) {
          Text('原文另有适用限制，以原文为准').fontSize(13).fontColor($r('[ui_components].color.text'))
        }
        if (entry.sourceRef?.field === 'material') {
          PromiseSourcePanel({ entry, sources: this.goods.promiseSources || [], controlId: 'goods-chart-source' })
        }
      }, (entry: PromiseEntry) => entry.quote || '')
      if (missingSizeChartText(entries)) {
        Text(missingSizeChartText(entries)).fontSize(14).fontColor($r('[ui_components].color.gray'))
      }
      Row({ space: 16 }) {
        ForEach(['偏大', '偏小', '标准'], (fit: string) => {
          Text((entries.some(entry => entry.fit === fit) ? '✓ ' : '') + fit)
            .fontWeight(entries.some(entry => entry.fit === fit) ? FontWeight.Bold : FontWeight.Normal)
            .fontSize(15).fontColor($r('[ui_components].color.text'))
        }, (fit: string) => fit)
      }
      if (!entries.some(entry => entry.fieldId === 'fit')) {
        Text('商家未说明版型').fontSize(14).fontColor($r('[ui_components].color.gray'))
      }
      ForEach(entries.filter(entry => entry.fieldId === 'fit'), (entry: PromiseEntry) => {
        Text('原文：' + entry.quote).fontSize(14).fontColor($r('[ui_components].color.text'))
        if (entry.conditionNeedsReview) {
          Text('原文另有适用限制，以原文为准').fontSize(13).fontColor($r('[ui_components].color.text'))
        }
        if (entry.sourceRef?.field === 'material') {
          PromiseSourcePanel({ entry, sources: this.goods.promiseSources || [], controlId: 'goods-fit-source' })
        }
      }, (entry: PromiseEntry) => entry.quote || '')
    }.width('100%').alignItems(HorizontalAlign.Start).padding({ left: 16, right: 16, bottom: 12 })
  }

  build() {
    Column() {
      Row() {
        Text('商品详情')
          .fontSize(13)
          .fontWeight(700)
          .fontColor($r('[ui_components].color.black'))
          .margin({ left: 16 })
      }
      .width('100%')
      .height(50)

      if (this.goods.categoryName === '服饰' || this.goods.categoryName === '鞋靴') {
        this.Sizing(this.publishedEntries())
      }
      ForEach(this.publishedEntries().filter(entry => entry.fieldId !== 'fit' && entry.fieldId !== 'size-chart'), (entry: PromiseEntry) => {
        Column({ space: 6 }) {
          Text(entry.label + '：' + (entry.value || '') + (entry.unit || ''))
            .fontColor($r('[ui_components].color.text')).width('100%')
          if (entry.condition) {
            Text('适用条件：' + entry.condition).fontSize(13).fontColor($r('[ui_components].color.text')).width('100%')
          }
          if (entry.conditionNeedsReview) {
            Text('原文另有适用限制，以原文为准').fontSize(13).fontColor($r('[ui_components].color.text')).width('100%')
          }
          PromiseSourcePanel({ entry, sources: this.goods.promiseSources || [], controlId: 'goods-promise-source-' + entry.fieldId })
        }.width('100%').padding({ left: 16, right: 16, bottom: 12 }).alignItems(HorizontalAlign.Start)
      }, (entry: PromiseEntry) => entry.fieldId + ':' + (this.goods.promiseSnapshot?.receiptId || ''))

      ForEach(this.getDetailPictures(), (src: string) => {
        Image(src)
          .width('100%')
      })
    }
    .backgroundColor($r('[ui_components].color.white'))
    .margin({ bottom: 8 })
  }
}
