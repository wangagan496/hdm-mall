import { Goods } from '../../domain/models'

// ─── 定义强类型的评价数据模型 ───
class CommentModel {
  userName: string = '';
  spec: string = '';
  time: string = '';
  content: string = '';
}

@Component
export struct GoodsComment {
  // 接收外部传入的商品信息
  @Prop goods: Goods = {} as Goods

  commentList: CommentModel[] = [
    {
      userName: 'K**u',
      spec: '默认规格',
      time: '今天 08:30',
      content: '太棒了，实物和描述一致，做工细致，下次还会再来光顾！'
    },
    {
      userName: 'J**n',
      spec: '尊享版',
      time: '昨天 23:45',
      content: '包装很严实，没有破损。使用体验很好，值得推荐购买。'
    }
  ]

  getCommentPictures(commentIndex: number): ResourceStr[] {
    const pictures: ResourceStr[] = []
    const candidates: ResourceStr[] = []
    if (!this.goods) {
      return pictures
    }

    if (this.goods.mainPictures) {
      candidates.push(...this.goods.mainPictures)
    }
    if (this.goods.details && this.goods.details.pictures) {
      candidates.push(...this.goods.details.pictures)
    }
    if (this.goods.picture) {
      candidates.push(this.goods.picture)
    }

    candidates.forEach((picture: ResourceStr) => {
      if (pictures.indexOf(picture) === -1) {
        pictures.push(picture)
      }
    })

    const start: number = commentIndex * 3
    return pictures.slice(start, start + 3)
  }

  build() {
    Column() {
      // ─── 评价头部 ───
      Row() {
        Text('商品评价')
          .fontSize(13)
          .fontWeight(700)
          .fontColor($r('[ui_components].color.black'))
          .margin({ right: 8 })
        Text('(100+)')
          .fontSize(13)
          .fontColor($r('[ui_components].color.gray'))
        Blank()
        Text('查看全部')
          .fontSize(13)
          .fontColor($r('[ui_components].color.gray'))
        Image($r('[ui_components].media.ic_public_right'))
          .width(20)
          .aspectRatio(1)
          .fillColor($r('[ui_components].color.gray'))
      }
      .width('100%')
      .height(40)

      // ─── 评价列表 ───
      ForEach(this.commentList, (item: CommentModel, index: number) => {
        Column({ space: 8 }) {
          // 头像与用户名
          Row() {
            Image($r('app.media.goods_avatar'))
              .width(24)
              .aspectRatio(1)
              .margin({ right: 8 })
            Text(item.userName)
              .fontColor($r('[ui_components].color.black'))
              .fontSize(14)
          }
          .width('100%')

          // 规格与时间
          Row() {
            Text(item.spec)
              .fontColor($r('[ui_components].color.gray'))
              .fontSize(12)
            Blank()
            Text(item.time)
              .fontColor($r('[ui_components].color.gray'))
              .fontSize(12)
          }
          .width('100%')

          // 评价正文
          Text(item.content)
            .fontColor($r('[ui_components].color.text'))
            .fontSize(13)

          // 每张商品图只分配给一条评价，图片不足时不重复占位。
          if (this.getCommentPictures(index).length > 0) {
            Row({ space: 8 }) {
              ForEach(this.getCommentPictures(index), (picture: ResourceStr) => {
                Image(picture)
                  .width(80)
                  .aspectRatio(1)
                  .objectFit(ImageFit.Cover)
                  .borderRadius(4)
              })
            }
            .width('100%')
          }
        }
        .margin({ top: 16 })
      })
    }
    .backgroundColor($r('[ui_components].color.white'))
    .borderRadius(8)
    .margin({ left: 8, right: 8, bottom: 8 })
    .padding(8)
  }
}
