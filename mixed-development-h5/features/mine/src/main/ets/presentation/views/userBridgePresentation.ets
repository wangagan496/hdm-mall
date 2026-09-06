import { HDMUser } from 'models'

export function mergeBridgeUser(current: HDMUser | undefined, update: HDMUser): HDMUser {
  return {
    token: update.token || current?.token || '',
    nickname: update.nickname || current?.nickname || update.account || current?.account || '',
    avatar: update.avatar,
    account: update.account || current?.account || ''
  }
}
