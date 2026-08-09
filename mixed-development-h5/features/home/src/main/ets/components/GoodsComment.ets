import { HDMGoodsItem } from "basic"

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
  goods: HDMGoodsItem = {} as HDMGoodsItem

  // 用于存放随机生成的评价列表
  @State commentList: CommentModel[] = []

  // 组件即将出现时，初始化随机评价
  aboutToAppear() {
    this.commentList = [this.getRandomComment(), this.getRandomComment()]
  }

  // ─── 核心：万能随机评价生成器 ───
  getRandomComment(): CommentModel {
    const users = ['匿名用户12**9', '购物狂**仙女', '数码**达人', 'J**n', '佛系买**家', '天**客']
    const specs = ['官方标配', '经典款', '默认规格', '尊享版', '常规规格']
    const times = ['今天 08:30', '昨天 23:45', '2天前', '刚刚', '昨天 14:20']
    const contents = [
      '质量非常好，完全超出期望值，发货速度非常快！',
      '很满意的一次购物，做工精细，实物比图片还好看，物超所值！',
      '包装很严实，没有破损。用起来感觉很不错，强烈推荐购买。',
      '太棒了，简直是挖到宝了，下次还会再来光顾的！',
      '老客户了，一如既往的好，性价比很高，闭眼入就对了。'
    ]

    return {
      userName: users[Math.floor(Math.random() * users.length)],
      spec: specs[Math.floor(Math.random() * specs.length)],
      time: times[Math.floor(Math.random() * times.length)],
      content: contents[Math.floor(Math.random() * contents.length)]
    }
  }

  build() {
    Column() {
      // ─── 评价头部 ───
      Row() {
        Text('商品评价')
          .fontSize(13)
          .fontWeight(700)
          .fontColor($r('[basic].color.black'))
          .margin({ right: 8 })
        Text('(100+)')
          .fontSize(13)
          .fontColor($r('[basic].color.gray'))
        Blank()
        Text('查看全部')
          .fontSize(13)
          .fontColor($r('[basic].color.gray'))
        Image($r('[basic].media.ic_public_right'))
          .width(20)
          .aspectRatio(1)
          .fillColor($r('[basic].color.gray'))
      }
      .width('100%')
      .height(40)

      // ─── 评价列表 (遍历生成的随机数据) ───
      ForEach(this.commentList, (item: CommentModel) => {
        Column({ space: 8 }) {
          // 头像与用户名
          Row() {
            Image($r('app.media.goods_avatar'))
              .width(24)
              .aspectRatio(1)
              .margin({ right: 8 })
            Text(item.userName)
              .fontColor($r('[basic].color.black'))
              .fontSize(14)
          }
          .width('100%')

          // 规格与时间
          Row() {
            Text(item.spec)
              .fontColor($r('[basic].color.gray'))
              .fontSize(12)
            Blank()
            Text(item.time)
              .fontColor($r('[basic].color.gray'))
              .fontSize(12)
          }
          .width('100%')

          // 评价正文
          Text(item.content)
            .fontColor($r('[basic].color.text'))
            .fontSize(13)

          // 评价配图 (直接复用该商品的主图展示，显得更真实)
          Row({ space: 8 }) {
            ForEach(new Array(3).fill(0), () => {
              Image(this.goods.picture)
                .width(80)
                .aspectRatio(1)
            })
          }
          .width('100%')
        }
        .margin({ top: 16 })
      })
    }
    .backgroundColor($r('[basic].color.white'))
    .borderRadius(8)
    .margin({ left: 8, right: 8, bottom: 8 })
    .padding(8)
  }
}