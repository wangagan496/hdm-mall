<script setup lang="ts">
import { request } from '@/api'
import { flattenAreaData, type Area } from '@/utils/area'
import { closeToast, showLoadingToast, showToast, type ActionSheetAction } from 'vant'
import { computed, onMounted, ref } from 'vue'

interface IPickerParams {
  selectedValues: string[]
  selectedOptions: {
    text: string
    value: string
  }[]
  selectedIndexes: number[]
}

const showAvatarSheet = ref(false)

const selectAvatar = async (_action: ActionSheetAction, index: number) => {
  const bridge = window.mk
  if (!bridge) {
    showToast({ message: '当前环境不支持选择头像' })
    return
  }

  try {
    const base64 = index === 0
      ? await bridge.pickerCamera()
      : await bridge.pickerPhoto()
    if (base64) {
      userInfo.value.avatar = `data:image/jpeg;base64,${base64}`
    }
  } catch {
    showToast({ message: '头像获取失败' })
  }
}

const showBirthdayPopup = ref(false)

const onChangeBirthday = ({ selectedValues }: IPickerParams) => {
  showBirthdayPopup.value = false
  userInfo.value.birthday = selectedValues.join('-')
}

const birthdayList = computed(() => {
  const birthday = userInfo.value.birthday
  return /^\d{4}-\d{2}-\d{2}$/.test(birthday) ? birthday.split('-') : []
})

const showAreaPopup = ref(false)
const areaColumns = ref<Area[]>([])
const areaData = ref<Record<string, string>>({})

const loadAreaColumns = (): boolean => {
  try {
    const source = window.mk?.getAreaColumns()
    if (!source) {
      return false
    }
    const columns = JSON.parse(source) as unknown
    if (!Array.isArray(columns)) {
      return false
    }
    areaColumns.value = columns as Area[]
    areaData.value = flattenAreaData(areaColumns.value)
    return areaColumns.value.length > 0
  } catch {
    return false
  }
}

const openAreaPopup = () => {
  if (!areaColumns.value.length && !loadAreaColumns()) {
    showToast({ message: '地区服务暂不可用，请稍后重试' })
    return
  }
  showAreaPopup.value = true
}

const selectArea = (area: IPickerParams) => {
  const [provinceCode, cityCode, countyCode] = area.selectedValues
  const locations = [provinceCode, cityCode, countyCode].map((code) => code ? areaData.value[code] : undefined)
  if (!provinceCode || !cityCode || !countyCode || locations.some((name) => !name)) {
    showToast({ message: '请选择完整的省、市、区' })
    return
  }

  showAreaPopup.value = false
  userInfo.value.provinceCode = provinceCode
  userInfo.value.cityCode = cityCode
  userInfo.value.countyCode = countyCode
  userInfo.value.fullLocation = locations.join(' ')
}

// 选择职业
const jobColumns = [
  { text: '软件工程师', value: '软件工程师' },
  { text: '医生', value: '医生' },
  { text: '教师', value: '教师' },
  { text: '律师', value: '律师' },
  { text: '会计师', value: '会计师' },
  { text: '销售经理', value: '销售经理' },
  { text: '市场营销专员', value: '市场营销专员' },
  { text: '建筑师', value: '建筑师' },
  { text: '护士', value: '护士' },
  { text: '机械工程师', value: '机械工程师' },
]

const showJobPopup = ref(false)
const onChangejob = (job: IPickerParams) => {
  showJobPopup.value = false
  userInfo.value.profession = job.selectedValues[0]!
}

const userInfo = ref<HDMUser>({} as HDMUser)

onMounted(() => {
  getUserInfo()
})

const getUserInfo = async () => {
  showLoadingToast({ message: '加载中...', duration: 0, forbidClick: true })
  try {
    const res = await request.get('member/profile')
    userInfo.value = res.data.result
  } catch {
    showToast({ message: '资料加载失败，请稍后重试' })
  } finally {
    closeToast()
  }
}

const isLoading = ref(false)
const onSubmit = async () => {
  if (!window.mk?.updateUser) {
    showToast({ message: '当前环境不支持保存资料' })
    return
  }

  isLoading.value = true
  try {
    await request.put('/member/profile', userInfo.value)
    await window.mk.updateUser(userInfo.value)
    showToast('修改成功')
  } catch {
    showToast({ message: '资料保存失败，请稍后重试' })
  } finally {
    isLoading.value = false
  }
}
</script>

<template>
  <div class="profile-edit-page">
    <!-- 头像部分 -->
    <div class="avatar">
      <van-image round width="100" height="100" class="avatar-img" :src="userInfo.avatar">
      </van-image>
      <div class="avatar-btn" @click="showAvatarSheet = true">
        <span>修改头像</span>
      </div>
    </div>
    <!-- 头像选择弹窗 -->
    <van-action-sheet
      v-model:show="showAvatarSheet"
      :actions="[{ name: '拍照' }, { name: '相册' }]"
      cancel-text="取消"
      close-on-click-action
      @select="selectAvatar"
    />

    <!-- 中间表单部分 -->
    <van-cell-group>
      <van-field label="账号" readonly :model-value="userInfo.account"></van-field>
      <van-field label="昵称" placeholder="请输入昵称" v-model="userInfo.nickname"></van-field>
      <van-cell title="性别" class="gender">
        <van-radio-group :icon-size="16" v-model="userInfo.gender">
          <van-radio name="男">男</van-radio>
          <van-radio name="女">女</van-radio>
          <van-radio name="未知">未知</van-radio>
        </van-radio-group>
      </van-cell>
      <van-field
        label="生日"
        readonly
        placeholder="请选择日期"
        v-model="userInfo.birthday"
        @click="showBirthdayPopup = true"
      ></van-field>
      <van-popup v-model:show="showBirthdayPopup" position="bottom" :style="{ height: '40%' }">
        <van-date-picker
          v-model="birthdayList"
          title="选择日期"
          :min-date="new Date('1950-01-01')"
          @cancel="showBirthdayPopup = false"
          @confirm="onChangeBirthday"
        />
      </van-popup>
      <van-field
        label="所在地"
        readonly
        placeholder="请选择所在地"
        @click="openAreaPopup"
        v-model="userInfo.fullLocation"
      ></van-field>
      <van-popup v-model:show="showAreaPopup" position="bottom" :style="{ height: '40%' }">
        <van-picker
          :columns="areaColumns"
          :columns-field-names="{ text: 'name', value: 'code', children: 'areaList' }"
          @cancel="showAreaPopup = false"
          @confirm="selectArea"
        ></van-picker>
      </van-popup>
      <van-field
        label="职业"
        readonly
        placeholder="请选择职业"
        v-model="userInfo.profession"
        @click="showJobPopup = true"
      ></van-field>
      <van-popup v-model:show="showJobPopup" position="bottom" :style="{ height: '40%' }">
        <van-picker
          @cancel="showJobPopup = false"
          :columns="jobColumns"
          @confirm="onChangejob"
        ></van-picker>
      </van-popup>
    </van-cell-group>

    <div class="submit">
      <van-button round block type="primary" @click="onSubmit" :loading="isLoading">
        保存资料
      </van-button>
    </div>
  </div>
</template>

<style lang="css" scoped>
.avatar {
  padding: 30px;
  text-align: center;
  background-color: var(--mk-white);
}

.avatar-img {
  box-shadow: 0 0 5px #ccc;
}

.avatar-btn {
  color: var(--mk-linear_end);
  margin-top: 10px;
}

.gender ::v-deep(.van-cell__title) {
  width: 100px;
  flex: none;
}

.van-radio-group {
  display: flex;
  justify-content: space-between;
  height: 36px;
  width: 180px;
}

.submit {
  padding: 16px;
}
</style>
