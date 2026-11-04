import { HDMUser } from 'models'

export function mergeBridgeUser(current: HDMUser | undefined, update: HDMUser): HDMUser {
  if (!current?.token || update.token !== current.token || update.id !== current.id) {
    throw new Error('登录状态已变化，请重新打开资料页')
  }
  return {
    id: current?.id,
    role: current?.role,
    token: current.token,
    nickname: update.nickname,
    avatar: update.avatar,
    account: current.account
  }
}
