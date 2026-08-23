import { TabItem } from 'models'

// 1. 抽离业务枚举
export enum TabIndex {
  HOME = 0,
  CATEGORY = 1,
  CART = 2,
  MINE = 3
}

// 2. 抽离静态 Tab 数据配置
export const TAB_LIST: TabItem[] = [
  { text: '首页', normal: $r('app.media.ic_public_home_normal'), active: $r('app.media.ic_public_home_active') },
  { text: '分类', normal: $r('app.media.ic_public_pro_normal'), active: $r('app.media.ic_public_pro_active') },
  { text: '购物袋', normal: $r('app.media.ic_public_cart_normal'), active: $r('app.media.ic_public_cart_active') },
  { text: '我的', normal: $r('app.media.ic_public_my_normal'), active: $r('app.media.ic_public_my_active') },
]