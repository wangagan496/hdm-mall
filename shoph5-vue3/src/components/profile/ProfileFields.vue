<script setup lang="ts">
import { ref } from 'vue'
import { showToast } from 'vant'
import { flattenAreaData, type Area } from '@/utils/area'

// 这个双向表单编辑页面提供的资料草稿，不在字段选择时提交服务器。
const profileDraft = defineModel<HDMUser>({ required: true })
defineProps<{ nicknameError: string }>()

interface PickerSelection {
  selectedValues: string[]
  selectedOptions: {
    text: string
    value: string
  }[]
  selectedIndexes: number[]
}

const showBirthdayPopup = ref(false)

const applySelectedBirthday = ({ selectedValues }: PickerSelection) => {
  showBirthdayPopup.value = false
  profileDraft.value.birthday = selectedValues.join('-')
}

const birthdayParts = ref<string[]>([])
const openBirthdayPopup = () => {
  const birthday = profileDraft.value.birthday
  birthdayParts.value = /^\d{4}-\d{2}-\d{2}$/.test(birthday) ? birthday.split('-') : []
  showBirthdayPopup.value = true
}

const showAreaPopup = ref(false)
const areaColumns = ref<Area[]>([])
const areaNamesByCode = ref<Record<string, string>>({})

const loadAreaColumns = (): boolean => {
  try {
    const source = window.nativeApp?.getAreaColumns()
    if (!source) {
      return false
    }
    const columns = JSON.parse(source) as unknown
    if (!Array.isArray(columns)) {
      return false
    }
    areaColumns.value = columns as Area[]
    areaNamesByCode.value = flattenAreaData(areaColumns.value)
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

const applySelectedArea = (area: PickerSelection) => {
  const [provinceCode, cityCode, countyCode] = area.selectedValues
  const selectedAreaNames = [provinceCode, cityCode, countyCode].map((code) => code ? areaNamesByCode.value[code] : undefined)
  if (!provinceCode || !cityCode || !countyCode || selectedAreaNames.some((name) => !name)) {
    showToast({ message: '请选择完整的省、市、区' })
    return
  }

  showAreaPopup.value = false
  profileDraft.value.provinceCode = provinceCode
  profileDraft.value.cityCode = cityCode
  profileDraft.value.countyCode = countyCode
  profileDraft.value.fullLocation = selectedAreaNames.join(' ')
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
const applySelectedProfession = (job: PickerSelection) => {
  showJobPopup.value = false
  profileDraft.value.profession = job.selectedValues[0]!
}
</script>

<template>
  <!-- 中间表单部分 -->
  <van-cell-group inset class="form-group">
    <van-field label="账号" readonly :model-value="profileDraft.account"></van-field>
    <van-field label="昵称" placeholder="请输入昵称" v-model="profileDraft.nickname" :error-message="nicknameError"></van-field>
    <van-cell title="性别" class="gender">
      <van-radio-group :icon-size="16" v-model="profileDraft.gender">
        <van-radio name="男">男</van-radio>
        <van-radio name="女">女</van-radio>
        <van-radio name="未知">未知</van-radio>
      </van-radio-group>
    </van-cell>
    <van-field
      label="生日"
      readonly
      placeholder="请选择日期"
      v-model="profileDraft.birthday"
      @click="openBirthdayPopup"
    ></van-field>
    <van-popup v-model:show="showBirthdayPopup" position="bottom" :style="{ height: '40%' }">
      <van-date-picker
        v-model="birthdayParts"
        title="选择日期"
        :min-date="new Date('1950-01-01')"
        @cancel="showBirthdayPopup = false"
        @confirm="applySelectedBirthday"
      />
    </van-popup>
    <van-field
      label="所在地"
      readonly
      placeholder="请选择所在地"
      @click="openAreaPopup"
      v-model="profileDraft.fullLocation"
    ></van-field>
    <van-popup v-model:show="showAreaPopup" position="bottom" :style="{ height: '40%' }">
      <van-picker
        :columns="areaColumns"
        :columns-field-names="{ text: 'name', value: 'code', children: 'areaList' }"
        @cancel="showAreaPopup = false"
        @confirm="applySelectedArea"
      ></van-picker>
    </van-popup>
    <van-field
      label="职业"
      readonly
      placeholder="请选择职业"
      v-model="profileDraft.profession"
      @click="showJobPopup = true"
    ></van-field>
    <van-popup v-model:show="showJobPopup" position="bottom" :style="{ height: '40%' }">
      <van-picker
        @cancel="showJobPopup = false"
        :columns="jobColumns"
        @confirm="applySelectedProfession"
      ></van-picker>
    </van-popup>
  </van-cell-group>
</template>

<style scoped>
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
</style>
