interface HarmonyBridge {
  getApiBaseUrl: () => string
  getUser: () => HDMUser | undefined // 读取 App 已保存的当前登录用户
  updateUser: (user: HDMUser) => Promise<void> // 更新用户
  removeUser: () => Promise<void> // 清除用户
  expireSession: (token: string) => Promise<boolean>
  setProfileDirty: (dirty: boolean, token: string, reason?: string) => void
  setProfileDraftRetained?: (token: string, retained: boolean) => void
  completeProfileFlush?: (requestId: number, token: string, saved: boolean) => void
  pickerCamera: () => Promise<string> // 调用相机拍照，返回base64字符串
  pickerPhoto: () => Promise<string> // 调用相册选择图片，返回base64字符串
  vibrator: () => void // 调用传感器
  getAreaColumns: () => string
}

interface Window {
  nativeApp?: HarmonyBridge // App 提供给网页的能力；普通浏览器中不存在
}



// 当前系统用户的类型
interface HDMUser {
  account: string
  avatar: string
  birthday: string
  cityCode: string // 市
  gender: '男' | '女' | '未知'
  id: string
  mobile: string
  nickname: string
  profession: string
  provinceCode: string // 省
  token: string
  countyCode: string // 区
  fullLocation: string
}
