import { PromiseEntry, PromiseMaterialSource, parsePromiseMaterialSource } from 'models'

export function materialKindLabel(kind: string): string {
  if (kind === 'inspection-report') return '检验报告'
  if (kind === 'authorization') return '授权书'
  return '批次说明'
}

export function verificationLabel(status: string): string {
  if (status === 'verified') return '已按所列依据核验'
  if (status === 'unverifiable') return '无法核验'
  if (status === 'provided') return '商家提供'
  return '待核验'
}

export function availabilityLabel(status: string): string {
  if (status === 'batch-mismatch') return '批次不匹配'
  if (status === 'not-yet-valid') return '尚未生效'
  if (status === 'withdrawn') return '已撤销'
  if (status === 'expired') return '已失效'
  return ''
}

export function materialDate(time: number): string {
  return new Date(time + 8 * 3600000).toISOString().slice(0, 10)
}

@Component
export struct PromiseSourcePanel {
  @Prop entry: PromiseEntry
  @Prop sources: PromiseMaterialSource[] = []
  @Prop controlId: string = ''
  @Prop historical: boolean = false
  @State expanded: boolean = false

  private source(): PromiseMaterialSource | null {
    const match = this.sources.find(item => item.fieldId === this.entry.fieldId)
    return match ? parsePromiseMaterialSource(JSON.stringify(match)) : null
  }

  @Builder
  private Material(source: PromiseMaterialSource) {
    Column({ space: 5 }) {
      Text(materialKindLabel(source.record.kind) + ' · 第 ' + source.record.version + ' 版')
        .id(this.controlId + '-version').fontSize(14).fontColor($r('[ui_components].color.text')).width('100%')
      Text('适用商品：' + source.record.productName).fontSize(13).fontColor($r('[ui_components].color.text')).width('100%')
      Text('适用批次：' + source.record.batch).fontSize(13).fontColor($r('[ui_components].color.text')).width('100%')
      Text('有效期：' + materialDate(source.record.validFrom) + ' 至 ' + materialDate(source.record.validUntil - 1))
        .fontSize(13).fontColor($r('[ui_components].color.text')).width('100%')
      Text((this.historical ? '下单时：' : '') + '商家提供 · ' + verificationLabel(source.record.verificationStatus) +
        (source.record.availability === 'applicable' ? '' : ' · ' + availabilityLabel(source.record.availability)))
        .fontSize(13).fontColor($r('[ui_components].color.text')).width('100%')
      if (source.record.verificationStatus === 'verified' && source.record.verifiedAt !== null) {
        Text('核验人：' + (source.record.verifier || '') + ' · ' + materialDate(source.record.verifiedAt))
          .fontSize(13).fontColor($r('[ui_components].color.text')).width('100%')
        Text('核验依据：' + (source.record.basis || '')).fontSize(13).fontColor($r('[ui_components].color.text')).width('100%')
      }
      Text('公开摘要：' + source.record.summary).fontSize(13).fontColor($r('[ui_components].color.text')).width('100%')
      Text('已核验也只表示所列检查完成，不保证商品为真').fontSize(13).fontColor($r('[ui_components].color.text')).width('100%')
      Text('上传成功不等于保真').fontSize(13).fontColor($r('[ui_components].color.text')).width('100%')
    }.width('100%').alignItems(HorizontalAlign.Start)
  }

  private statusNotice(): string {
    const source = this.source()
    if (!source || source.currentAvailability === 'applicable') return ''
    if (this.historical && source.record.availability !== source.currentAvailability &&
      (source.currentAvailability === 'expired' || source.currentAvailability === 'withdrawn')) {
      return '该材料当前已失效'
    }
    return availabilityLabel(source.currentAvailability)
  }

  build() {
    if (this.entry.status === 'known' && this.entry.quote) {
      Column({ space: 5 }) {
        if (this.historical && !this.expanded && this.entry.sourceRef?.field === 'material') {
          Text('商家填写的材料说明：' + this.entry.quote)
            .fontSize(13).fontColor($r('[ui_components].color.gray')).width('100%')
        }
        Row({ space: 8 }) {
          Button(this.expanded ? '收起来源' : '来源').id(this.controlId)
            .backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.text'))
            .onClick(() => { this.expanded = !this.expanded })
          if (this.statusNotice()) {
            Text(this.statusNotice()).fontSize(13).fontColor($r('[ui_components].color.red')).layoutWeight(1)
          }
        }.width('100%')
        if (this.expanded) {
          if (this.entry.sourceRef?.field === 'material') {
            if (this.source()) {
              this.Material(this.source()!)
            } else {
              Text('材料来源暂未读到，请刷新').fontSize(13).fontColor($r('[ui_components].color.text')).width('100%')
            }
          } else {
            Text('来自商品详情').fontSize(13).fontColor($r('[ui_components].color.text')).width('100%')
            Text('商品资料原文：' + this.entry.quote)
              .fontSize(13).fontColor($r('[ui_components].color.text')).width('100%')
          }
        }
      }.width('100%').alignItems(HorizontalAlign.Start)
    }
  }
}
