import { HDMUser, IdentityLayout, IdentityLayoutUpdate, parseIdentityLayout, sameIdentitySession } from 'models'
import { RequestAxios } from 'network'
import { auth } from './Auth'

export const IDENTITY_LAYOUT_KEY: string = 'identityHomeLayout'

export interface CurrentIdentityLayout {
  identityRevision?: number
  value?: IdentityLayout
}

export function entryVisible(user: HDMUser, current: CurrentIdentityLayout, entry: string): boolean {
  return !user.token || !current.value || user.identityRevision !== current.identityRevision || user.identity !== current.value.identity ||
    !current.value.hiddenEntries.includes(entry)
}

export class IdentityLayouts {
  async read(user: HDMUser): Promise<IdentityLayout | null> {
    if (!user.identity || !sameIdentitySession(auth.getUserInfo(), user)) return null
    const value = await RequestAxios.getForSession<Object>('/member/identity-layout', user.token)
    return this.publish(user, value)
  }

  async save(user: HDMUser, payload: IdentityLayoutUpdate): Promise<IdentityLayout | null> {
    if (!sameIdentitySession(auth.getUserInfo(), user)) return null
    const value = await RequestAxios.putForSession<Object>('/member/identity-layout', payload, user.token)
    return this.publish(user, value)
  }

  private publish(user: HDMUser, value: Object): IdentityLayout | null {
    if (!sameIdentitySession(auth.getUserInfo(), user)) return null
    const layout = parseIdentityLayout(JSON.stringify(value))
    if (!layout || layout.identity !== user.identity) throw new Error('入口设置暂时无法读取')
    const current = AppStorage.get<CurrentIdentityLayout>(IDENTITY_LAYOUT_KEY)
    if (current?.identityRevision === user.identityRevision && current?.value?.identity === layout.identity &&
      current.value.revision > layout.revision) return current.value
    AppStorage.setOrCreate<CurrentIdentityLayout>(IDENTITY_LAYOUT_KEY, { identityRevision: user.identityRevision, value: layout })
    return layout
  }

}

export const identityLayouts = new IdentityLayouts()
