import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { execute, sourceOf, deferred, tick } from './native-harness.mjs'
const requireH5 = createRequire(new URL('../../shoph5-vue3/package.json', import.meta.url))
const vue = requireH5('vue')

test('H5 仅当前请求的401清会话，断网及服务器错误保留登录，提示只由页面负责', async () => {
  let user = { token: 'current' }, requestHandler, responseError, expired = 0, events = 0
  const instance = { interceptors: { request: { use: callback => { requestHandler = callback } }, response: { use: (_ok, callback) => { responseError = callback } } } }
  const { requestErrorMessage } = execute(sourceOf('shoph5-vue3/src/api/index.ts').replaceAll('import.meta.env', '({})'), {
    axios: { __esModule: true, default: { create: () => instance, isAxiosError: error => error.isAxiosError } },
  }, { window: { nativeApp: { getUser: () => user, getApiBaseUrl: () => 'http://fixture', expireSession: async token => {
    assert.equal(token, user.token); expired++; user = { token: '' }; return true
  } }, dispatchEvent: () => events++ }, Event: class { constructor(type) { this.type = type } } })
  assert.equal(requestHandler({ headers: { Authorization: 'Bearer old' } }).headers.Authorization, 'Bearer old')
  for (const status of [undefined, 500]) {
    await assert.rejects(responseError({ response: status ? { status } : undefined, config: { headers: { Authorization: 'Bearer current' } } }))
    assert.equal(user.token, 'current')
  }
  await assert.rejects(responseError({ response: { status: 401 }, config: { headers: { Authorization: 'Bearer old' } } }))
  assert.equal(expired, 0)
  const currentFailure = { isAxiosError: true, response: { status: 401 }, config: { headers: { Authorization: 'Bearer current' } } }
  await Promise.allSettled([responseError(currentFailure), responseError(currentFailure)])
  assert.equal(expired, 1); assert.equal(events, 1); assert.equal(user.token, '')
  assert.match(requestErrorMessage(currentFailure), /重新登录/)
})

function pageFixture() {
  const timers = new Map(), dirty = [], writes = []
  let timerId = 0, mounted, unmounted, perform = async () => true
  const profileDraft = vue.ref({ nickname: '原昵称', token: 'session' }), pageState = vue.ref('loading')
  const isSaving = vue.ref(false), saveError = vue.ref(''), saved = vue.ref('原昵称')
  const hasUnsavedChanges = vue.computed(() => profileDraft.value.nickname !== saved.value)
  const nicknameError = vue.computed(() => pageState.value === 'ready' && !profileDraft.value.nickname?.trim() ? '昵称不能为空' : '')
  const refs = { profileDraft, pageState, isSaving, saveError, hasUnsavedChanges, nicknameError }
  const store = {
    loadProfile: async () => { pageState.value = 'ready' },
    saveProfile: async () => {
      isSaving.value = true
      const nickname = profileDraft.value.nickname; writes.push(nickname)
      try {
        if (await perform()) { saved.value = nickname; return true }
        saveError.value = '保存失败'; return false
      } finally { isSaving.value = false }
    },
  }
  const source = sourceOf('shoph5-vue3/src/views/ProfileEdit.vue').split('<script setup lang="ts">')[1].split('</script>')[0]
  execute(source, {
    vue: { ...vue, onMounted: callback => { mounted = callback }, onBeforeUnmount: callback => { unmounted = callback } },
    pinia: { storeToRefs: () => refs }, '@/stores/profile': { useProfileStore: () => store },
    vant: { closeToast: () => {}, showLoadingToast: () => {} },
  }, {
    window: { nativeApp: { setProfileDirty: (value, token, reason) => { dirty.push(value); store.leaveReason = reason } }, addEventListener: () => {}, removeEventListener: () => {} },
    setTimeout: (callback, delay) => { assert.equal(delay, 600); timers.set(++timerId, callback); return timerId }, clearTimeout: id => timers.delete(id),
  })
  const fire = () => { const [id, callback] = timers.entries().next().value; timers.delete(id); return callback() }
  return { ...refs, timers, writes, dirty, leaveReason: () => store.leaveReason, mounted: () => mounted(), unmounted: () => unmounted(), fire, setPerform: fn => { perform = fn } }
}

test('清空昵称取消待保存计时，并把原因传到原生离页提示', async () => {
  const f = pageFixture(); f.mounted(); await tick()
  f.profileDraft.value.nickname = '待保存'; await vue.nextTick(); assert.equal(f.timers.size, 1)
  f.profileDraft.value.nickname = ' '; await vue.nextTick()
  assert.equal(f.timers.size, 0); assert.equal(f.leaveReason(), '昵称不能为空')
  assert.equal(f.dirty.at(-1), true); assert.equal(f.writes.length, 0)
  f.unmounted()
})
test('资料页连续输入合并自动保存，保存中的新修改继续排队且无成功弹窗', async () => {
  const f = pageFixture(); f.mounted(); await tick()
  f.profileDraft.value.nickname = '第一字'; await vue.nextTick()
  f.profileDraft.value.nickname = '提交内容'; await vue.nextTick(); assert.equal(f.timers.size, 1)
  const gate = deferred(); f.setPerform(() => gate.promise)
  const first = f.fire(); f.profileDraft.value.nickname = '等待期间的新内容'; await vue.nextTick()
  gate.resolve(true); await first; await vue.nextTick()
  assert.deepEqual(f.writes, ['提交内容']); assert.equal(f.timers.size, 1); assert.equal(f.hasUnsavedChanges.value, true)
  f.setPerform(async () => true); await f.fire(); await vue.nextTick()
  assert.deepEqual(f.writes, ['提交内容', '等待期间的新内容']); assert.equal(f.hasUnsavedChanges.value, false)
  assert.equal(f.dirty.at(-1), false); f.unmounted()
})
test('资料页失败停止自动重试，离开清除尚未触发的保存', async () => {
  const f = pageFixture(); f.mounted(); await tick(); f.setPerform(async () => false)
  f.profileDraft.value.nickname = '失败草稿'; await vue.nextTick(); await f.fire(); await vue.nextTick()
  assert.equal(f.timers.size, 0); assert.equal(f.hasUnsavedChanges.value, true)
  f.profileDraft.value.nickname = '离开前输入'; await vue.nextTick(); assert.equal(f.timers.size, 1)
  f.unmounted(); assert.equal(f.timers.size, 0); assert.equal(f.writes.length, 1)
})
