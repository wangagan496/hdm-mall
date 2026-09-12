import { auth } from './Auth'

const ANONYMOUS_SCOPE: string = 'anonymous'

/**
 * 按当前登录账号生成本地数据的存储作用域：
 *   favorite_goods_account_<account> / browse_history_account_<account> / demo_order_overlay_account_<account>
 * 未登录时统一落在匿名作用域。收藏、浏览足迹、演示订单覆盖层共用同一套规则，
 * 保证不同账号之间的本地记录互不可见，退出登录后也不会读到上一个账号的数据。
 */
export function getAccountStorageScope(): string {
  const account = auth.getUserInfo()?.account?.trim()
  if (!account) {
    return ANONYMOUS_SCOPE
  }
  return `account_${encodeURIComponent(account)}`
}

export function getAccountScopedKey(key: string): string {
  return `${key}_${getAccountStorageScope()}`
}
