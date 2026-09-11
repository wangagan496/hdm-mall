<script setup lang="ts">
import { flattenAreaData, type Area } from '@/utils/area'
import { closeToast, showLoadingToast, showToast, type ActionSheetAction } from 'vant'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref } from 'vue'
import { useProfileStore } from '@/stores/profile'

interface IPickerParams {
  selectedValues: string[]
  selectedOptions: {
    text: string
    value: string
  }[]
  selectedIndexes: number[]
}

const profileStore = useProfileStore()
const { userInfo, pageState, isLoading, isDirty } = storeToRefs(profileStore)

const showAvatarSheet = ref(false)
const isPickingAvatar = ref(false)

const openAvatarSheet = () => {
  if (!isPickingAvatar.value) {
    showAvatarSheet.value = true
  }
}

const selectAvatar = async (_action: ActionSheetAction, index: number) => {
  const bridge = window.mk
  if (!bridge) {
    showToast({ message: '当前环境不支持选择头像' })
    return
  }

  isPickingAvatar.value = true
  showLoadingToast({ message: '正在读取头像...', duration: 0, forbidClick: true })
  try {
    const base64 = index === 0
      ? await bridge.pickerCamera()
      : await bridge.pickerPhoto()
    closeToast()
    if (base64) {
      profileStore.setAvatarPreview(base64)
    }
  } catch (error) {
    closeToast()
    console.error('头像选择失败', error)
    showToast({ message: '头像获取失败' })
  } finally {
    isPickingAvatar.value = false
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

const loadUserInfo = async () => {
  showLoadingToast({ message: '加载中...', duration: 0, forbidClick: true })
  await profileStore.loadUserInfo()
  closeToast()
}

onMounted(() => {
  loadUserInfo()
})

const onSubmit = async () => {
  if (!window.mk?.updateUser) {
    showToast({ message: '当前环境不支持保存资料' })
    return
  }
  if (!isDirty.value) {
    showToast({ message: '资料没有变化，无需保存' })
    return
  }

  const ok = await profileStore.saveProfile()
  showToast(ok ? '修改成功' : { message: '资料保存失败，请稍后重试' })
}
</script>

<template>
  <div class="profile-edit-page">
    <!-- 加载失败：空态 + 重试，而不是只有一个 toast -->
    <van-empty v-if="pageState === 'error'" description="资料加载失败">
      <van-button round type="primary" size="small" @click="loadUserInfo">
        重新加载
      </van-button>
    </van-empty>

    <!-- 加载中：骨架屏 -->
    <template v-else-if="pageState === 'loading'">
      <van-skeleton title :row="8" :loading="true" class="skeleton" />
    </template>

    <template v-else>
      <!-- 头像部分 -->
      <div class="avatar">
        <button
          type="button"
          class="avatar-button"
          aria-label="修改头像"
          :disabled="isPickingAvatar"
          @click="openAvatarSheet"
        >
          <van-image round width="100" height="100" class="avatar-img" :src="userInfo.avatar">
          </van-image>
          <span>修改头像</span>
        </button>
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
      <van-cell-group inset class="form-group">
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
        <van-button
          round
          block
          type="primary"
          :disabled="!isDirty"
          :loading="isLoading"
          @click="onSubmit"
        >
          保存资料
        </van-button>
      </div>
    </template>
  </div>
</template>

<style lang="css" scoped>
.profile-edit-page {
  min-height: 100vh;
  padding-bottom: calc(24px + env(safe-area-inset-bottom));
}

.skeleton {
  padding: 24px 16px;
}

.avatar {
  padding: 30px;
  text-align: center;
  background-color: var(--mk-white);
}

.avatar-img {
  box-shadow: var(--mk-card-shadow);
}

.avatar-button {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 0;
  border: 0;
  color: var(--mk-linear_end);
  background: transparent;
  font: inherit;
  cursor: pointer;
}

.avatar-button:focus-visible {
  outline: 2px solid var(--mk-linear_end);
  outline-offset: 6px;
  border-radius: 8px;
}

.avatar-button:disabled {
  cursor: wait;
  opacity: 0.65;
}

.avatar-button span {
  color: var(--mk-linear_end);
}

.form-group {
  margin-top: 12px;
}

.gender :deep(.van-cell__title) {
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
