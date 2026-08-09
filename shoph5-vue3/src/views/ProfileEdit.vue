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
  try {
    const base64 = index === 0
      ? await harmonyos.pickerCamera()
      : await harmonyos.pickerPhoto()
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

const birthdayList = computed(() => userInfo.value.birthday?.split('-') ?? [])

const showAreaPopup = ref(false)
const areaColumns = ref<Area[]>(JSON.parse(harmonyos.getAreaColumns()))
const areaData = flattenAreaData(areaColumns.value)

const selectArea = (area: IPickerParams) => {
  showAreaPopup.value = false
  userInfo.value.provinceCode = area.selectedValues[0]!
  userInfo.value.cityCode = area.selectedValues[1]!
  userInfo.value.countyCode = area.selectedValues[2]!
  userInfo.value.fullLocation = [
    areaData[area.selectedValues[0]!],
    areaData[area.selectedValues[1]!],
    areaData[area.selectedValues[2]!],
  ].join(' ')
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
  const res = await request.get('member/profile')
  closeToast()
  userInfo.value = res.data.result
}

const isLoading = ref(false)
const onSubmit = async () => {
  isLoading.value = true
  try {
    await request.put('/member/profile', userInfo.value)
    harmonyos.updateUser(userInfo.value)
    showToast('修改成功')
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
        @click="showAreaPopup = true"
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
