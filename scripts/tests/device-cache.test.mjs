import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execute, sourceOf, deferred, tick, pageMethods } from './native-harness.mjs'

const speechSource = sourceOf('mixed-development-h5/commons/device/src/main/ets/SpeechToTextManager.ets')
function speechFixture(createOverride) {
  let listener, creates = 0, shutdowns = 0, finishes = 0, uuid = 0
  const timers = new Map()
  const engine = { setListener: value => { listener = value }, startListening: () => {},
    shutdown: () => { shutdowns++ }, finish: () => { finishes++ } }
  const { SpeechToTextManager } = execute(speechSource, {
    '@kit.CoreSpeechKit': { speechRecognizer: { createEngine: async () => { creates++; return createOverride ? createOverride(engine) : engine } } },
    '@kit.ArkTS': { util: { generateRandomUUID: () => String(++uuid) } },
  }, { setTimeout: callback => { timers.set(1, callback); return 1 }, clearTimeout: id => timers.delete(id) })
  return { manager: new SpeechToTextManager(), engine, listener: () => listener,
    counts: () => ({ creates, shutdowns, finishes }), timers }
}
test('引擎预创建复用同一任务，取消后迟到引擎释放', async () => {
  const gate = deferred(), f = speechFixture(async engine => { await gate.promise; return engine })
  const one = f.manager.createEngine(), two = f.manager.createEngine()
  assert.equal(one, two); assert.equal(f.counts().creates, 1)
  f.manager.cancelRecognition(); gate.resolve()
  await assert.rejects(one, /取消/)
  assert.equal(f.counts().shutdowns, 1)
  assert.equal(f.manager.engine, null)
  await f.manager.createEngine(); assert.equal(f.counts().creates, 2)
  f.manager.cancelRecognition()
})
test('松手后等待最终文字，重复完成只返回一次并释放引擎', async () => {
  const f = speechFixture(); await f.manager.startRecognition()
  const id = f.manager.sessionId, listener = f.listener()
  listener.onResult(id, { result: '红色', isFinal: false, isLast: false })
  let settled = false
  const result = f.manager.stopRecognition().then(value => { settled = true; return value })
  await tick(); assert.equal(settled, false); assert.equal(f.counts().shutdowns, 0)
  listener.onResult(id, { result: '红色书包', isFinal: true, isLast: true })
  listener.onComplete(id); listener.onComplete(id)
  assert.equal(await result, '红色书包')
  assert.equal(f.counts().shutdowns, 1)
  assert.equal(f.timers.size, 0)
})
test('空完成、超时、识别失败均不把中间文字当查询', async () => {
  for (const mode of ['empty', 'timeout', 'error']) {
    const f = speechFixture(); await f.manager.startRecognition()
    const id = f.manager.sessionId
    f.listener().onResult(id, { result: '中间', isFinal: false, isLast: false })
    const result = f.manager.stopRecognition()
    if (mode === 'empty') f.listener().onComplete(id)
    if (mode === 'timeout') f.timers.get(1)()
    if (mode === 'error') f.listener().onError(id)
    await assert.rejects(result, /完整语音|超时|失败/)
    assert.equal(f.counts().shutdowns, 1)
  }
})
test('连续识别丢弃旧会话，完整重复分句不误删', async () => {
  const f = speechFixture(); await f.manager.startRecognition()
  const oldId = f.manager.sessionId, oldListener = f.listener()
  f.manager.cancelRecognition(); await f.manager.startRecognition()
  const id = f.manager.sessionId
  oldListener.onResult(oldId, { result: '旧词', isFinal: true, isLast: true })
  f.listener().onResult(id, { result: '好', isFinal: true, isLast: false })
  const result = f.manager.stopRecognition()
  f.listener().onResult(id, { result: '好', isFinal: true, isLast: true })
  assert.equal(await result, '好好')
})
test('权限等待期间松手或离开，不启动麦克风', async () => {
  for (const leave of [false, true]) {
    const permission = deferred(); let recordings = 0, recognitions = 0
    const Page = pageMethods('mixed-development-h5/features/home/src/main/ets/presentation/components/HDMAudioSearch.ets', 'HDMAudioSearch', {}, {
      VoiceState: { IDLE: 0, LISTENING: 1, START_FAILED: 2, PROCESSING: 3 },
      accessManager: { runWithPermissions: () => permission.promise },
      speechToTextManager: { createEngine: async () => {}, cancelRecognition: () => {}, startRecognition: async () => { recognitions++ } },
      audioCapturerManager: { start: async () => { recordings++ }, stop: async () => {} },
      vibrator: { stopVibration: async () => {}, VibratorStopMode: { VIBRATOR_STOP_MODE_TIME: 0 } },
    })
    const page = new Page(); page.getUIContext = () => ({ getHostContext: () => ({}), getPromptAction: () => ({ showToast: () => {} }) })
    page.aboutToAppear(); page.requestMicrophoneAndStart()
    const ended = leave ? page.aboutToDisappear() : page.stopVoiceRecognition()
    permission.resolve({ granted: true, prompted: false }); await ended; await tick()
    assert.equal(recordings, 0); assert.equal(recognitions, 0)
  }
})
