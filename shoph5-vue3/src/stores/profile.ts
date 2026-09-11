import { request } from '@/api'
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
}

interface AvatarUploadResponse {
  result: {
    avatar: string
  }
}

// 资料保存只提交可编辑字段，账号、token 等由原生端持有
const createProfileUpdatePayload = (user: HDMUser): ProfileUpdatePayload => ({
  nickname: user.nickname,
  gender: user.gender,
  birthday: user.birthday,
  provinceCode: user.provinceCode,
  cityCode: user.cityCode,
  countyCode: user.countyCode,
  profession: user.profession,
})

const base64ToAvatarFile = (base64: string): File => {
  const binary = window.atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }
  return new File([bytes], 'avatar.jpg', { type: 'image/jpeg' })
}

/**
 * 个人资料页状态：页面三段状态、资料字段与待上传头像都收在这里，
 * 保存流程按「头像上传 → 资料 PUT → 原生桥同步」三步执行。
 */
export const useProfileStore = defineStore('profile', () => {
  const userInfo = ref<HDMUser>({} as HDMUser)
  const pageState = ref<ProfilePageState>('loading')
  // 最近一次成功保存/加载的字段快照，用于脏检查（无修改时禁用保存按钮）
  const savedSnapshot = ref('')
  // 头像接口成功后先保留地址，直到原生桥同步和资料保存都成功，支持失败重试
  const pendingAvatarBase64 = ref('')
  const uploadedAvatarUrl = ref('')
  const isLoading = ref(false)

  const isProfileDirty = computed(() => {
    if (pageState.value !== 'ready') {
      return false
    }
    return JSON.stringify(createProfileUpdatePayload(userInfo.value)) !== savedSnapshot.value
  })

  // 头像待上传同样视为有未保存改动
  const isDirty = computed(() => isProfileDirty.value || pendingAvatarBase64.value !== '')

  const applySnapshot = () => {
    savedSnapshot.value = JSON.stringify(createProfileUpdatePayload(userInfo.value))
  }

  // 相机/相册返回 base64 后先进入本地预览态
  const setAvatarPreview = (base64: string) => {
    pendingAvatarBase64.value = base64
    uploadedAvatarUrl.value = ''
    userInfo.value.avatar = `data:image/jpeg;base64,${base64}`
  }

  const clearPendingAvatar = () => {
    pendingAvatarBase64.value = ''
    uploadedAvatarUrl.value = ''
  }

  const loadUserInfo = async () => {
    pageState.value = 'loading'
    try {
      const res = await request.get('member/profile')
      const sessionUser = window.mk?.queryUser()
      userInfo.value = {
        ...sessionUser,
        ...res.data.result,
        token: sessionUser?.token || '',
      } as HDMUser
      applySnapshot()
      pageState.value = 'ready'
    } catch {
      pageState.value = 'error'
    }
  }

  const uploadPendingAvatar = async (): Promise<string> => {
    const formData = new FormData()
    formData.append('file', base64ToAvatarFile(pendingAvatarBase64.value))
    const response = await request.post<AvatarUploadResponse>('/member/profile/avatar', formData)
    const avatar = response.data.result.avatar
    if (!avatar) {
      throw new Error('头像上传接口未返回头像地址')
    }
    return avatar
  }

  /**
   * 保存资料。成功返回 true，失败返回 false（提示由调用方负责）。
   * 中间步骤失败时保留待上传地址，允许重试。
   */
  const saveProfile = async (): Promise<boolean> => {
    isLoading.value = true
    try {
      if (pendingAvatarBase64.value) {
        if (!uploadedAvatarUrl.value) {
          uploadedAvatarUrl.value = await uploadPendingAvatar()
        }
        userInfo.value.avatar = uploadedAvatarUrl.value
      }
      await request.put('/member/profile', createProfileUpdatePayload(userInfo.value))
      await window.mk!.updateUser(userInfo.value)
      clearPendingAvatar()
      applySnapshot()
      return true
    } catch {
      return false
    } finally {
      isLoading.value = false
    }
  }

  return {
    userInfo,
    pageState,
    isLoading,
    pendingAvatarBase64,
    uploadedAvatarUrl,
    isProfileDirty,
    isDirty,
    applySnapshot,
    setAvatarPreview,
    clearPendingAvatar,
    loadUserInfo,
    saveProfile,
  }
})
