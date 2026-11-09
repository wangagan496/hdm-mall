import { request, requestErrorMessage } from '@/api'
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

export type ProfilePageState = 'loading' | 'ready' | 'error'
export interface ProfileUpdatePayload {
  nickname: string
  gender: HDMUser['gender']
  birthday: string
  provinceCode: string
  cityCode: string
  countyCode: string
  profession: string
  fullLocation: string
}
interface RetainedProfileDraft {
  fields: ProfileUpdatePayload
  avatarBase64: string
  expiresAt: number
}
const buildProfileUpdate = (user: HDMUser): ProfileUpdatePayload => ({
  nickname: user.nickname, gender: user.gender, birthday: user.birthday,
  provinceCode: user.provinceCode, cityCode: user.cityCode, countyCode: user.countyCode,
  profession: user.profession, fullLocation: user.fullLocation,
})
const base64ToAvatarFile = (base64: string): File => {
  const binary = window.atob(base64)
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
  return new File([bytes], 'avatar.jpg', { type: 'image/jpeg' })
}

// 输入是草稿；保存基准和原生同步只采用服务器已确认的资料。
export const useProfileStore = defineStore('profile', () => {
  const profileDraft = ref<HDMUser>({} as HDMUser)
  const pageState = ref<ProfilePageState>('loading')
  const savedProfileJson = ref('')
  const pendingAvatarBase64 = ref('')
  const isSaving = ref(false)
  const saveError = ref('')
  const pendingNativeProfile = ref<HDMUser>()
  let confirmedProfile: HDMUser | undefined
  let loadSequence = 0
  let pendingSave: Promise<boolean> | undefined
  const draftKey = (id: string) => 'hdm-profile-draft:' + id
  const retainDraft = (): boolean => {
    const user = profileDraft.value
    if (!user.id || !user.token || window.nativeApp?.getUser()?.token !== user.token) return false
    try {
      if (!hasUnsavedChanges.value) window.localStorage.removeItem(draftKey(user.id))
      else window.localStorage.setItem(draftKey(user.id), JSON.stringify({
        fields: buildProfileUpdate(user), avatarBase64: pendingAvatarBase64.value,
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      } satisfies RetainedProfileDraft))
      return true
    } catch { return false }
  }
  const restoreDraft = (user: HDMUser) => {
    try {
      const text = window.localStorage.getItem(draftKey(user.id))
      if (!text) return
      const draft = JSON.parse(text) as RetainedProfileDraft
      if (!draft.fields || draft.expiresAt < Date.now()) { window.localStorage.removeItem(draftKey(user.id)); return }
      for (const key of Object.keys(buildProfileUpdate(user)) as (keyof ProfileUpdatePayload)[]) {
        if (typeof draft.fields[key] === 'string') Object.assign(profileDraft.value, { [key]: draft.fields[key] })
      }
      if (typeof draft.avatarBase64 === 'string' && draft.avatarBase64) {
        pendingAvatarBase64.value = draft.avatarBase64
        profileDraft.value.avatar = 'data:image/jpeg;base64,' + draft.avatarBase64
      }
      pendingNativeProfile.value = { ...user }
    } catch { /* A damaged local draft must not replace confirmed server data. */ }
  }
  const nicknameError = computed(() => pageState.value === 'ready' && !profileDraft.value.nickname?.trim()
    ? '昵称不能为空' : '')

  const hasProfileChanges = computed(() => pageState.value === 'ready' &&
    JSON.stringify(buildProfileUpdate(profileDraft.value)) !== savedProfileJson.value)
  const hasUnsavedChanges = computed(() => hasProfileChanges.value ||
    pendingAvatarBase64.value !== '' || !!pendingNativeProfile.value)
  const recordSavedProfile = (savedProfile: HDMUser) => {
    confirmedProfile = { ...savedProfile }
    savedProfileJson.value = JSON.stringify(buildProfileUpdate(savedProfile))
  }
  const assertCurrentSession = (token: string, sequence: number) => {
    if (!token || sequence !== loadSequence || window.nativeApp?.getUser()?.token !== token) {
      throw new Error('登录状态已变化，请重新打开资料页')
    }
  }
  const setAvatarPreview = (base64: string) => {
    if (pageState.value !== 'ready') return
    pendingAvatarBase64.value = base64
    profileDraft.value.avatar = 'data:image/jpeg;base64,' + base64
  }
  const loadProfile = async () => {
    const sequence = ++loadSequence
    pageState.value = 'loading'
    pendingAvatarBase64.value = ''
    pendingNativeProfile.value = undefined
    profileDraft.value = {} as HDMUser
    const token = window.nativeApp?.getUser()?.token || ''
    try {
      assertCurrentSession(token, sequence)
      const response = await request.get<{ result: HDMUser }>('/member/profile', {
        headers: { Authorization: 'Bearer ' + token },
      })
      assertCurrentSession(token, sequence)
      const loaded = response.data.result
      if (loaded.token !== token || loaded.id !== window.nativeApp?.getUser()?.id) {
        throw new Error('资料与当前登录账号不一致')
      }
      profileDraft.value = { ...loaded }
      recordSavedProfile(loaded)
      saveError.value = ''
      pageState.value = 'ready'
      restoreDraft(loaded)
    } catch {
      if (sequence === loadSequence) pageState.value = 'error'
    }
  }
  const syncConfirmedProfile = async (token: string, sequence: number) => {
    const profile = pendingNativeProfile.value
    if (!profile) return
    assertCurrentSession(token, sequence)
    if (!window.nativeApp?.updateUser) throw new Error('当前环境不支持同步资料')
    await window.nativeApp.updateUser({ ...profile })
    assertCurrentSession(token, sequence)
    if (pendingNativeProfile.value === profile) pendingNativeProfile.value = undefined
  }
  const persistProfile = async (): Promise<boolean> => {
    const sequence = loadSequence
    const submitted = { ...profileDraft.value }
    const token = submitted.token
    const avatarBase64 = pendingAvatarBase64.value
    const headers = { Authorization: 'Bearer ' + token }
    isSaving.value = true
    saveError.value = ''
    try {
      assertCurrentSession(token, sequence)
      if (avatarBase64) {
        const form = new FormData()
        form.append('file', base64ToAvatarFile(avatarBase64))
        const response = await request.post<{ result: { avatar: string } }>('/member/profile/avatar', form, { headers })
        assertCurrentSession(token, sequence)
        const avatar = response.data.result.avatar
        if (!avatar) throw new Error('头像上传接口未返回头像地址')
        // 上传接口已经保存头像；后续资料失败也不能假装头像未保存。
        submitted.avatar = avatar
        if (confirmedProfile) confirmedProfile = { ...confirmedProfile, avatar }
        pendingNativeProfile.value = confirmedProfile ? { ...confirmedProfile } : undefined
        if (pendingAvatarBase64.value === avatarBase64) {
          pendingAvatarBase64.value = ''
          profileDraft.value.avatar = avatar
          retainDraft()
        }
        await syncConfirmedProfile(token, sequence)
      }
      if (JSON.stringify(buildProfileUpdate(submitted)) !== savedProfileJson.value) {
        const response = await request.put<{ result: HDMUser }>('/member/profile', buildProfileUpdate(submitted), { headers })
        assertCurrentSession(token, sequence)
        const saved = response.data.result
        if (saved.token !== token || saved.id !== submitted.id) throw new Error('服务器返回的资料不完整，请重新加载')
        recordSavedProfile(saved)
        // 未再修改的字段接受服务端规范化；等待期间的新输入继续保留。
        for (const field of Object.keys(buildProfileUpdate(submitted)) as (keyof ProfileUpdatePayload)[]) {
          if (profileDraft.value[field] === submitted[field]) {
            Object.assign(profileDraft.value, { [field]: saved[field] })
          }
        }
        pendingNativeProfile.value = { ...saved }
      }
      await syncConfirmedProfile(token, sequence)
      retainDraft()
      return true
    } catch (error) {
      if (sequence === loadSequence) {
        saveError.value = pendingNativeProfile.value
          ? (hasProfileChanges.value ? '头像已保存，手机同步失败，其余修改仍未保存，请重试' : '资料已保存，手机同步失败，请重试同步')
          : requestErrorMessage(error)
      }
      return false
    } finally {
      isSaving.value = false
    }
  }
  const saveProfile = (): Promise<boolean> => {
    if (nicknameError.value) {
      saveError.value = nicknameError.value
      return Promise.resolve(false)
    }
    if (pendingSave) return pendingSave
    if (pageState.value !== 'ready') return Promise.resolve(false)
    if (!hasUnsavedChanges.value) return Promise.resolve(true)
    pendingSave = persistProfile().finally(() => { pendingSave = undefined })
    return pendingSave
  }
  const flushProfile = async (): Promise<boolean> => {
    const token = profileDraft.value.token
    const sequence = loadSequence
    retainDraft()
    // Drain the active write and then the latest input, without overlapping uploads.
    for (let attempt = 0; attempt < 4; attempt++) {
      if (!await saveProfile()) { retainDraft(); return false }
      try { assertCurrentSession(token, sequence) } catch { return false }
      if (!hasUnsavedChanges.value) { retainDraft(); return true }
    }
    retainDraft()
    return false
  }
  return { profileDraft, pageState, isSaving, saveError, nicknameError, pendingAvatarBase64,
    hasProfileChanges, hasUnsavedChanges, recordSavedProfile, setAvatarPreview, loadProfile, saveProfile, flushProfile, retainDraft }
})
