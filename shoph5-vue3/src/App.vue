<script setup lang="ts">
import { ref } from 'vue'

// 浏览器直开 / 原生容器未注入 window.mk 时提示能力降级，不阻塞页面演示
const hasBridge = typeof window !== 'undefined' && !!window.mk
const showBridgeTip = ref(!hasBridge)
</script>

<template>
  <van-notice-bar
    v-if="showBridgeTip"
    wrapable
    :scrollable="false"
    text="未检测到鸿蒙容器（window.mk），拍照/相册/地区能力不可用，当前仅展示页面效果。"
  />
  <RouterView />
</template>

<style lang="scss" scoped></style>
