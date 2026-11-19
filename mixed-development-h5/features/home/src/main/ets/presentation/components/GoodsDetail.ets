import { Goods } from '../../domain/models'
import { PromiseEntry, parsePromiseSnapshot } from 'models'
import { PromiseSourcePanel } from 'ui_components'

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

      ForEach(this.publishedEntries(), (entry: PromiseEntry) => {
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
