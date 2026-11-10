import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execute, sourceOf, deferred, pageMethods } from './native-harness.mjs'

function fixture(initial, requestResult, settingResult) {
  const calls = []
  const permissions = ['ohos.permission.MICROPHONE']
  const manager = {
    checkAccessTokenSync: () => initial,
    requestPermissionsFromUser: async (...args) => { calls.push(['request', ...args]); return requestResult },
    requestPermissionOnSetting: async (...args) => {
      calls.push(['setting', ...args])
      if (settingResult instanceof Error || (settingResult && !Array.isArray(settingResult))) throw settingResult
      return settingResult
    },
  }
  const { accessManager } = execute(sourceOf('mixed-development-h5/commons/device/src/main/ets/AccessManager.ets'), {
    '@kit.AbilityKit': {
      abilityAccessCtrl: { createAtManager: () => manager, GrantStatus: { PERMISSION_GRANTED: 0 } },
      bundleManager: { BundleFlag: {}, getBundleInfoForSelfSync: () => ({ appInfo: { accessTokenId: 1 } }) },
    },
  })
  let grantedCount = 0
  return {
    calls,
    permissions,
    granted: () => grantedCount,
    run: () => accessManager.runWithPermissions({}, permissions, () => { grantedCount++ }),
  }
}

function assertOutcome(outcome, granted, prompted) {
  assert.equal(outcome.granted, granted)
  assert.equal(outcome.prompted, prompted)
}

test('已有权限直接执行回调且结果标记为未弹窗', async () => {
  const f = fixture(0, {}, [-1])
  assertOutcome(await f.run(), true, false)
  assert.equal(f.granted(), 1)
  assert.deepEqual(f.calls, [])
})

test('系统权限弹窗显示且用户同意时返回已授权并标记弹窗', async () => {
  const f = fixture(-1, { authResults: [0], dialogShownResults: [true] }, [-1])
  assertOutcome(await f.run(), true, true)
  assert.equal(f.granted(), 1)
  assert.deepEqual(f.calls.map(call => call[0]), ['request'])
})

test('系统权限弹窗显示且用户拒绝时不再调用设置授权窗', async () => {
  const f = fixture(-1, { authResults: [-1], dialogShownResults: [true] }, [0])
  assertOutcome(await f.run(), false, true)
  assert.equal(f.granted(), 0)
  assert.deepEqual(f.calls.map(call => call[0]), ['request'])
})

test('系统权限弹窗未显示时只调用一次设置授权窗并返回授权结果', async () => {
  const allowed = fixture(-1, { authResults: [-1], dialogShownResults: [false] }, [0])
  assertOutcome(await allowed.run(), true, true)
  assert.equal(allowed.granted(), 1)
  assert.deepEqual(allowed.calls.map(call => call[0]), ['request', 'setting'])
  assert.equal(allowed.calls.filter(call => call[0] === 'setting').length, 1)

  const denied = fixture(-1, { authResults: [-1], dialogShownResults: [false] }, [-1])
  assertOutcome(await denied.run(), false, true)
  assert.equal(denied.granted(), 0)
  assert.equal(denied.calls.filter(call => call[0] === 'setting').length, 1)
})

test('缺少 dialogShownResults 时按弹过窗处理，不再调用设置授权窗', async () => {
  const denied = fixture(-1, { authResults: [-1] }, [0])
  assertOutcome(await denied.run(), false, true)
  assert.deepEqual(denied.calls.map(call => call[0]), ['request'])

  const allowed = fixture(-1, { authResults: [0] }, [-1])
  assertOutcome(await allowed.run(), true, true)
  assert.equal(allowed.granted(), 1)
})

test('用户关闭设置授权窗时按拒绝返回', async () => {
  const f = fixture(-1, { authResults: [-1], dialogShownResults: [false] }, [-1])
  assertOutcome(await f.run(), false, true)
  assert.deepEqual(f.calls.map(call => call[0]), ['request', 'setting'])
})

test('用户未授权异常按拒绝返回，其他系统异常保留重试错误', async () => {
  const denied = fixture(-1, { authResults: [-1], dialogShownResults: [false] }, Object.assign(new Error('用户未授权'), { code: 201 }))
  assertOutcome(await denied.run(), false, true)
  const failed = fixture(-1, { authResults: [-1], dialogShownResults: [false] }, Object.assign(new Error('invalid parameter'), { code: 12100001 }))
  await assert.rejects(failed.run(), /权限申请失败，请重试/)
})

function voiceFixture(permissionRequest) {
  const toasts = []
  let recognitions = 0
  let recordings = 0
  const Page = pageMethods('mixed-development-h5/features/home/src/main/ets/presentation/components/HDMAudioSearch.ets', 'HDMAudioSearch', {}, {
    accessManager: { runWithPermissions: permissionRequest, hasPermissions:()=>true },
    storeManager: {getStore:()=>({getSync:()=>false,putSync(){},flush:async()=>{}})},
    speechToTextManager: {
      createEngine: async () => {},
      startRecognition: async () => { recognitions++ },
      cancelRecognition: () => {},
      sendAudio: () => {},
    },
    audioCapturerManager: { start: async () => { recordings++ }, stop: async () => {} },
    vibrator: { startVibration: async () => {}, stopVibration: async () => {}, VibratorStopMode: { VIBRATOR_STOP_MODE_TIME: 0 } },
    VoiceState: { IDLE: 0, LISTENING: 1, START_FAILED: 2, PROCESSING: 3 },
  })
  const page = new Page()
  page.microphoneExplained = true
  page.getUIContext = () => ({
    getHostContext: () => ({}),
    getPromptAction: () => ({ showToast: options => toasts.push(options.message),showDialog:async()=>({index:0}) }),
  })
  page.aboutToAppear()
  return { page, toasts, recognitions: () => recognitions, recordings: () => recordings }
}

test('已授权且本次弹窗后不录音，重置后再次长按可启动识别', async () => {
  const outcomes = [
    { granted: true, prompted: true },
    { granted: true, prompted: false },
  ]
  const permission = deferred()
  let first=true
  const f = voiceFixture(() => {if(first){first=false;return permission.promise}return Promise.resolve(outcomes.shift())})
  f.page.requestMicrophoneAndStart()
  const firstStart = f.page.starting
  assert.equal(f.page.holding, true)
  f.page.scaleValue = 1.5
  permission.resolve(outcomes.shift())
  await firstStart
  assert.equal(f.recognitions(), 0)
  assert.equal(f.recordings(), 0)
  assert.equal(f.page.holding, false)
  assert.equal(f.page.voiceState, 0)
  assert.equal(f.page.scaleValue, 1)
  assert.equal(f.page.starting, undefined)
  assert.deepEqual(f.toasts, ['已授权，请重新长按说话'])

  f.page.requestMicrophoneAndStart()
  const secondStart = f.page.starting
  await secondStart
  assert.equal(f.recognitions(), 1)
  assert.equal(f.recordings(), 1)
  assert.equal(f.page.voiceState, 1)
})

test('已授权且本次没有弹窗时正常启动录音', async () => {
  const f = voiceFixture(async () => ({ granted: true, prompted: false }))
  f.page.requestMicrophoneAndStart()
  await f.page.starting
  assert.equal(f.recognitions(), 1)
  assert.equal(f.recordings(), 1)
  assert.equal(f.page.voiceState, 1)
})

test('CD-L03 麦克风说明取消不请求系统权限',async()=>{
 let requests=0
 const f=voiceFixture(async()=>{requests++;return {granted:true,prompted:false}})
 f.page.explainMicrophone=async()=>false
 f.page.requestMicrophoneAndStart();await f.page.starting
 assert.equal(requests,0);assert.equal(f.recordings(),0)
})

test('拒绝权限后即使用户已松手仍显示设置提示并回到待机', async () => {
  const permission = deferred()
  const f = voiceFixture(() => permission.promise)
  f.page.requestMicrophoneAndStart()
  const starting = f.page.starting
  f.page.holding = false
  permission.resolve({ granted: false, prompted: true })
  await starting
  assert.deepEqual(f.toasts, ['请在设置中开启麦克风权限'])
  assert.equal(f.page.voiceState, 0)
  assert.equal(f.recognitions(), 0)
  assert.equal(f.recordings(), 0)
})
