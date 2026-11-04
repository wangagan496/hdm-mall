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

function memoryFiles() {
  let descriptor = 0
  const files = new Map(), opened = new Map(), directories = new Set()
  const api = {
    OpenMode: { CREATE: 1, WRITE_ONLY: 2, TRUNC: 4, READ_ONLY: 8 },
    accessSync: path => directories.has(path) || files.has(path), mkdirSync: path => directories.add(path),
    openSync: (path, mode) => {
      if (mode & 1) files.set(path, Buffer.alloc(0))
      if (!files.has(path)) throw new Error('missing file')
      const fd = ++descriptor; opened.set(fd, path); return { fd, path }
    },
    closeSync: file => opened.delete(typeof file === 'number' ? file : file.fd),
    writeSync: (fd, value) => { files.set(opened.get(fd), Buffer.from(value)); return Buffer.byteLength(value) },
    readSync: (fd, target) => { const data = files.get(opened.get(fd)); Buffer.from(target).set(data); return data.length },
    readTextSync: path => { if (!files.has(path)) throw new Error('missing'); return files.get(path).toString() },
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from) },
    unlinkSync: path => files.delete(path),
    statSync: path => { if (!files.has(path)) throw new Error('missing'); return { size: files.get(path).length } },
    listFileSync: path => [...files.keys()].filter(key => key.startsWith(path + '/')).map(key => key.slice(path.length + 1)),
  }
  return { files, opened, api }
}
function cacheFixture() {
  const fs = memoryFiles(), tasks = [], timers = new Map()
  let uuid = 0, time = 1_000_000, mode = 'success', downloads = 0, clockId = 0
  class FakeDate extends Date { static now() { return time } }
  const source = sourceOf('mixed-development-h5/commons/utils/src/main/ets/DownLoadManager.ets')
  const { DownLoadManager } = execute(source, {
    '@kit.CoreFileKit': { fileIo: fs.api },
    '@kit.ArkTS': { util: { generateRandomUUID: () => (++uuid).toString(16) } },
    '@kit.BasicServicesKit': { request: { downloadFile: async (_context, options) => {
      downloads++
      fs.files.set(options.filePath, Buffer.from('image-' + options.url))
      if (mode === 'create-fail') throw new Error('create failed')
      const events = {}, task = { on: (name, fn) => { events[name] = fn }, delete: async () => {}, options, events }
      tasks.push(task)
      if (mode !== 'hold') setImmediate(() => events[mode === 'fail' ? 'fail' : 'complete']?.())
      return task
    } } },
  }, { Date: FakeDate, setTimeout: callback => { timers.set(++clockId, callback); return clockId }, clearTimeout: id => timers.delete(id) })
  return { ...fs, tasks, timers, manager: new DownLoadManager(), newManager: () => new DownLoadManager(),
    context: { cacheDir: '/cache' }, count: () => downloads, setMode: value => { mode = value }, advance: value => { time += value } }
}
test('图片跨刷新和重启复用，坏文件和 TTL 过期会重新下载', async () => {
  const f = cacheFixture(), url = 'https://image.test/a?version=1'
  const first = await f.manager.downLoadImages(f.context, [url, url]); f.manager.releaseImages(first)
  const restarted = f.newManager(), second = await restarted.downLoadImages(f.context, [url])
  assert.equal(first[0], second[0]); assert.equal(f.count(), 1); restarted.releaseImages(second)
  f.files.set(first[0], Buffer.alloc(f.files.get(first[0]).length, 3))
  const fixed = await restarted.downLoadImages(f.context, [url]); assert.equal(f.count(), 2); restarted.releaseImages(fixed)
  f.advance(3_600_001)
  const fresh = await restarted.downLoadImages(f.context, [url]); assert.equal(f.count(), 3); restarted.releaseImages(fresh)
  assert.equal(f.files.has(first[0]), false)
  assert.equal(f.opened.size, 0)
})
test('图片在途请求合并，版本参数分开，引用未释放不清理', async () => {
  const f = cacheFixture(); f.setMode('hold')
  const one = f.manager.downLoadImages(f.context, ['https://i/a?v=1'])
  const two = f.manager.downLoadImages(f.context, ['https://i/a?v=1'])
  await tick(); assert.equal(f.count(), 1)
  f.tasks[0].events.complete()
  const paths = await one, paths2 = await two
  f.advance(3_600_001); f.manager.releaseImages(paths)
  assert.equal(f.files.has(paths[0]), true)
  f.manager.releaseImages(paths2); assert.equal(f.files.has(paths[0]), false)
  f.setMode('success')
  const versions = await f.manager.downLoadImages(f.context, ['https://i/a?v=2', 'https://i/a?v=3', 'file:///x'])
  assert.equal(versions.length, 2); assert.equal(f.count(), 3)
  f.manager.releaseImages(versions)
})
test('创建失败、下载失败和超时均结束等待、清残留并允许重试', async () => {
  for (const mode of ['create-fail', 'fail', 'hold']) {
    const f = cacheFixture(); f.setMode(mode)
    const download = f.manager.downLoadImages(f.context, ['https://i/a'])
    if (mode === 'hold') { await tick(); [...f.timers.values()][0]() }
    assert.equal((await download).length, 0)
    assert.equal([...f.files.keys()].filter(key => key.endsWith('.jpg')).length, 0)
    f.setMode('success'); const retry = await f.manager.downLoadImages(f.context, ['https://i/a'])
    assert.equal(retry.length, 1); f.manager.releaseImages(retry)
  }
})
test('缓存容量清理和坏索引孤儿回收只触及下载器图片', async () => {
  const f = cacheFixture()
  for (let i = 0; i < 35; i++) {
    const paths = await f.manager.downLoadImages(f.context, ['https://i/' + i]); f.manager.releaseImages(paths); f.advance(1)
  }
  assert.equal([...f.files.keys()].filter(key => key.endsWith('.jpg')).length, 32)
  f.files.set('/cache/card-images/ff.jpg', Buffer.from('orphan'))
  f.files.set('/cache/card-images/user-note.txt', Buffer.from('keep'))
  const paths = await f.newManager().downLoadImages(f.context, [])
  assert.equal(paths.length, 0)
  assert.equal(f.files.has('/cache/card-images/ff.jpg'), false)
  assert.equal(f.files.has('/cache/card-images/user-note.txt'), true)
})

function cardFixture(update) {
  const opened = new Set(), calls = []; let fd = 0
  const { PushCardManager } = execute(sourceOf('mixed-development-h5/commons/utils/src/main/ets/PushCardManager.ets'), {
    '@kit.CoreFileKit': { fileIo: { OpenMode: { READ_ONLY: 1 }, openSync: path => { if (path === 'bad') throw new Error('open failed'); opened.add(++fd); return { fd } }, closeSync: file => opened.delete(file.fd) } },
    '@kit.FormKit': { formBindingData: { createFormBindingData: fields => fields }, formProvider: { updateForm: async (id, data) => {
      assert.ok(Object.values(data.formImages).every(value => opened.has(value)))
      calls.push({ id, data }); return update(id, data, calls)
    } } },
  }, { setTimeout: callback => { queueMicrotask(callback); return 1 } })
  return { manager: new PushCardManager(), opened, calls }
}
test('卡片只重试可恢复的失败项，成功项不重发，重试结束释放句柄', async () => {
  const f = cardFixture(async (id, _data, calls) => {
    if (id === 'deleted') throw { code: 16500050 }
    if (id === 'retry' && calls.filter(call => call.id === id).length < 2) throw { code: 16501000 }
  })
  const result = await f.manager.pushImageToCard(['a.jpg'], ['ok', 'retry', 'deleted'])
  assert.deepEqual([...result.failedFormIds], ['deleted'])
  assert.equal(f.calls.filter(call => call.id === 'ok').length, 1)
  assert.equal(f.calls.filter(call => call.id === 'retry').length, 2)
  assert.equal(f.calls.filter(call => call.id === 'deleted').length, 1)
  assert.equal(f.opened.size, 0)
})
test('卡片持续失败最多三次，打开部分失败仍释放已打开文件', async () => {
  const f = cardFixture(async () => { throw { code: 16501000 } })
  assert.equal((await f.manager.pushImageToCard(['a.jpg'], ['retry'])).failedFormIds[0], 'retry')
  assert.equal(f.calls.length, 3); assert.equal(f.opened.size, 0)
  await assert.rejects(f.manager.pushImageToCard(['a.jpg', 'bad'], ['ok']), /open failed/)
  assert.equal(f.opened.size, 0)
})
test('新图排在旧图在途更新后，旧版本不再重试', async () => {
  const gate = deferred()
  const f = cardFixture(async (_id, data) => { if (data.imageList[0] === 'old') { await gate.promise; throw { code: 16501000 } } })
  const old = f.manager.pushImageToCard(['old'], ['card']); await tick()
  const latest = f.manager.pushImageToCard(['new'], ['card']); await tick()
  assert.equal(f.calls.length, 1); gate.resolve()
  assert.equal((await old).superseded, true); await latest
  assert.deepEqual(f.calls.map(call => call.data.imageList[0]), ['old', 'new'])
  assert.equal(f.opened.size, 0)
})

test('照片和相机无选择不误报成功，权限失败与执行失败有区别且释放文件', async () => {
  for (const camera of [false, true]) {
    let result = camera ? { resultCode: 0, resultUri: '' } : { photoUris: [] }, error, encodedError, closed = 0
    const fs = { openSync: () => ({ fd: 1 }), closeSync: () => closed++ }
    const select = async () => { if (error) throw error; return result }
    const dependencies = {
      '@kit.CoreFileKit': { fileIo: fs },
      './AvatarImage': { encodeAvatarFile: async () => { if (encodedError) throw encodedError; return 'base64-avatar' } },
      '@kit.MediaLibraryKit': { photoAccessHelper: { PhotoSelectOptions: class {}, PhotoViewMIMETypes: { IMAGE_TYPE: 1 }, PhotoViewPicker: class { select() { return select() } } } },
      '@kit.CameraKit': { camera: { CameraPosition: { CAMERA_POSITION_BACK: 0 } }, cameraPicker: { PickerMediaType: { PHOTO: 0 }, pick: select } },
    }
    const module = execute(sourceOf('mixed-development-h5/commons/device/src/main/ets/' + (camera ? 'CameraPlugin.ets' : 'PhotoPlugin.ets')), dependencies)
    const pick = () => camera ? module.cameraPlugin.pickerCamera({}) : module.photoPlugin.pickerPhoto()
    assert.equal(await pick(), ''); assert.equal(closed, 0)
    error = { code: 201 }; await assert.rejects(pick(), /权限/)
    error = { code: 13900042 }; await assert.rejects(pick(), /失败/)
    error = undefined; result = camera ? { resultCode: 0, resultUri: 'file' } : { photoUris: ['file'] }
    assert.equal(await pick(), 'base64-avatar'); assert.equal(closed, 1)
    encodedError = new Error('encode failed'); await assert.rejects(pick(), /失败/); assert.equal(closed, 2)
  }
})
