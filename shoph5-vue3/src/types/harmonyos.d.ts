declare const harmonyos: {
  queryUser: () => HDMUser
  updateUser: (user: HDMUser) => void // 更新用户
  pickerCamera: () => Promise<string> // 调用相机拍照，返回base64字符串
  pickerPhoto: () => Promise<string> // 调用相册选择图片，返回base64字符串
  vibrator: () => void // 调用传感器
  getAreaColumns:() => string
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


