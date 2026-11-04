<script setup lang="ts">
import { ref, onBeforeUnmount } from 'vue'
import { closeToast, showLoadingToast, showToast, type ActionSheetAction } from 'vant'

// 只负责选择和预览头像；上传与保存由页面的资料 store 处理。
defineProps<{ avatar: string }>()
const emit = defineEmits<{ selected: [avatarBase64: string] }>()

const showAvatarSheet = ref(false)
const isPickingAvatar = ref(false)
let active = true
onBeforeUnmount(() => { active = false })

const openAvatarSheet = () => {
  if (!isPickingAvatar.value) {
    showAvatarSheet.value = true
  }
}

const selectAvatar = async (_action: ActionSheetAction, index: number) => {
  const bridge = window.nativeApp
  if (!bridge) {
    showToast({ message: '当前环境不支持选择头像' })
    return
  }

  isPickingAvatar.value = true
  const token = bridge.getUser()?.token
  showLoadingToast({ message: '正在读取头像...', duration: 0, forbidClick: true })
  try {
    // 菜单第一个选项是拍照，第二个是相册。
    const takePhoto = index === 0
    const base64 = takePhoto
      ? await bridge.pickerCamera()
      : await bridge.pickerPhoto()
    closeToast()
    if (base64 && active && token && bridge.getUser()?.token === token) {
      emit('selected', base64)
    }
  } catch (error) {
    closeToast()
    if (active) showToast({ message: error instanceof Error ? error.message : '头像获取失败，请重试' })
  } finally {
    isPickingAvatar.value = false
  }
}
</script>

<template>
  <!-- 头像部分 -->
  <div class="avatar">
    <button
      type="button"
      class="avatar-button"
      aria-label="修改头像"
      :disabled="isPickingAvatar"
      @click="openAvatarSheet"
    >
      <van-image round width="100" height="100" class="avatar-img" :src="avatar">
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
</template>

<style scoped>
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
</style>
