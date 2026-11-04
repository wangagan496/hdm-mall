<script setup lang="ts">
import { closeToast, showLoadingToast } from 'vant'
import { storeToRefs } from 'pinia'
import { onMounted, onBeforeUnmount, watch } from 'vue'
import { useProfileStore } from '@/stores/profile'
import ProfileAvatar from '@/components/profile/ProfileAvatar.vue'
import ProfileFields from '@/components/profile/ProfileFields.vue'

// 页面串起加载、编辑和保存；头像与普通字段各自负责自己的输入。
const profileStore = useProfileStore()
const { profileDraft, pageState, isSaving, hasUnsavedChanges, saveError, nicknameError } = storeToRefs(profileStore)
let saveTimer: ReturnType<typeof setTimeout> | undefined
let active = true

const scheduleSave = () => {
  clearTimeout(saveTimer)
  if (!active || pageState.value !== 'ready' || !hasUnsavedChanges.value || nicknameError.value) return
  saveTimer = setTimeout(saveProfile, 600)
}

watch(() => [profileDraft.value.nickname, profileDraft.value.gender, profileDraft.value.birthday,
  profileDraft.value.provinceCode, profileDraft.value.cityCode, profileDraft.value.countyCode,
  profileDraft.value.profession, profileDraft.value.fullLocation, profileDraft.value.avatar], scheduleSave)
watch([hasUnsavedChanges, isSaving, nicknameError, saveError], () => {
  window.nativeApp?.setProfileDirty?.(hasUnsavedChanges.value || isSaving.value, profileDraft.value.token,
    nicknameError.value || saveError.value)
}, { flush: 'sync' })

const loadProfile = async () => {
  showLoadingToast({ message: '加载中...', duration: 0, forbidClick: true })
  await profileStore.loadProfile()
  closeToast()
}

onMounted(() => {
  loadProfile()
  window.addEventListener('native-session-expired', loadProfile)
})
onBeforeUnmount(() => {
  active = false
  clearTimeout(saveTimer)
  window.removeEventListener('native-session-expired', loadProfile)
})

const saveProfile = async () => {
  clearTimeout(saveTimer)
  const savedSuccessfully = await profileStore.saveProfile()
  if (savedSuccessfully && hasUnsavedChanges.value) scheduleSave()
}
</script>

<template>
  <div class="profile-edit-page">
    <van-empty v-if="pageState === 'error'" description="资料加载失败">
      <van-button round type="primary" size="small" @click="loadProfile">
        重新加载
      </van-button>
    </van-empty>

    <template v-else-if="pageState === 'loading'">
      <van-skeleton title :row="8" :loading="true" class="skeleton" />
    </template>

    <template v-else>
      <ProfileAvatar :avatar="profileDraft.avatar" @selected="profileStore.setAvatarPreview" />
      <ProfileFields v-model="profileDraft" :nickname-error="nicknameError" />

      <div v-if="saveError" class="submit" role="status">
        <p>{{ saveError }}</p>
        <van-button
          round
          block
          type="primary"
          :disabled="!hasUnsavedChanges"
          :loading="isSaving"
          @click="saveProfile"
        >
          重试保存或同步
        </van-button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.profile-edit-page {
  min-height: 100vh;
  padding-bottom: calc(24px + env(safe-area-inset-bottom));
}

.skeleton {
  padding: 24px 16px;
}

.submit {
  padding: 16px;
}
</style>
