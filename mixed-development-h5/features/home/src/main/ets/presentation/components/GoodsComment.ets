import { GoodsEvaluation } from '../../domain/models'

@Component
export struct GoodsComment {
  @Prop evaluations: GoodsEvaluation[] = []
  @Prop totalCount: number = 0
  @Prop loading: boolean = false

  private getMemberName(evaluation: GoodsEvaluation): string {
    return evaluation.member?.nickname || '匿名用户'
  }

  private getScoreText(evaluation: GoodsEvaluation): string {
    return evaluation.score.toFixed(1) + ' 分'
  }

  build() {
    Column() {
      Row() {
        Text('商品评价')
          .fontSize(13)
          .fontWeight(700)
          .fontColor($r('[ui_components].color.black'))
          .margin({ right: 8 })
        if (this.totalCount > 0) {
          Text('(' + this.totalCount.toString() + ')')
            .fontSize(13)
            .fontColor($r('[ui_components].color.gray'))
        }
        Blank()
        Text('最近评价')
          .fontSize(12)
          .fontColor($r('[ui_components].color.gray'))
      }
      .width('100%')
      .height(40)

      if (this.loading) {
        Text('正在加载评价...')
          .fontSize(13)
          .fontColor($r('[ui_components].color.gray'))
          .padding({ top: 16, bottom: 16 })
      } else if (this.evaluations.length === 0) {
        Text('暂无评价')
          .fontSize(13)
          .fontColor($r('[ui_components].color.gray'))
          .padding({ top: 16, bottom: 16 })
      } else {
        ForEach(this.evaluations, (evaluation: GoodsEvaluation) => {
          Column({ space: 8 }) {
            Row({ space: 8 }) {
              Image(evaluation.member?.avatar || $r('app.media.goods_avatar'))
                .width(24)
                .aspectRatio(1)
                .borderRadius(12)
              Text(this.getMemberName(evaluation))
                .fontColor($r('[ui_components].color.black'))
                .fontSize(14)
              Blank()
              Text(this.getScoreText(evaluation))
                .fontSize(12)
                .fontColor($r('[ui_components].color.red'))
            }
            .width('100%')

            Text(evaluation.createTime)
              .fontColor($r('[ui_components].color.gray'))
              .fontSize(12)

            Text(evaluation.content || '用户未填写评价内容')
              .fontColor($r('[ui_components].color.text'))
              .fontSize(13)
              .lineHeight(20)

            if (evaluation.pictures && evaluation.pictures.length > 0) {
              Row({ space: 8 }) {
                ForEach(evaluation.pictures, (picture: string, pictureIndex: number) => {
                  Image(picture)
                    .width(80)
                    .aspectRatio(1)
                    .objectFit(ImageFit.Cover)
                    .borderRadius(4)
                }, (picture: string, pictureIndex: number) => evaluation.id + '-' + pictureIndex.toString())
              }
              .width('100%')
            }
          }
          .margin({ top: 16 })
        }, (evaluation: GoodsEvaluation) => evaluation.id)
      }
    }
    .width('100%')
    .backgroundColor($r('[ui_components].color.white'))
    .borderRadius(8)
    .margin({ left: 8, right: 8, bottom: 8 })
    .padding(8)
  }
}
