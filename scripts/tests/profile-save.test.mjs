import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from '../../shoph5-vue3/node_modules/typescript/lib/typescript.js'
const requireH5 = createRequire(new URL('../../shoph5-vue3/package.json', import.meta.url))
const vue = requireH5('vue')
const pinia = requireH5('pinia')
const source = readFileSync(new URL('../../shoph5-vue3/src/stores/profile.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function fixture() {
  let user = { id: 'user-a', account: 'account-a', token: 'session-a', nickname: '原昵称', avatar: '', birthday: '', gender: '未知', provinceCode: '', cityCode: '', countyCode: '', profession: '', fullLocation: '', mobile: '' }
  let server = { ...user }
  const writes = [], synced = [], drafts = new Map()
  let put = async data => ({ data: { result: server = { ...server, ...data } } })
  let get = async () => ({ data: { result: { ...server } } })
  let post = async () => ({ data: { result: { avatar: 'https://example.test/avatar.jpg' } } })
  let sync = async data => { synced.push({ ...data }) }
  let uploads = 0
  const request = {
    get: (...args) => get(...args),
    put: async (_url, data) => { writes.push({ ...data }); return put(data) },
    post: async (...args) => { uploads++; return post(...args) },
  }
  const context = vm.createContext({ exports: {}, require: name => name === '@/api' ? { request, requestErrorMessage: () => '保存失败' } : requireH5(name),
    window: { localStorage: { getItem: key => drafts.get(key) ?? null, setItem: (key,value) => drafts.set(key,value), removeItem: key => drafts.delete(key) }, nativeApp: { getUser: () => user, updateUser: data => sync(data) }, atob: value => Buffer.from(value, 'base64').toString('binary') },
    FormData, File, Uint8Array, setTimeout, clearTimeout, console })
  pinia.setActivePinia(pinia.createPinia())
  vm.runInContext(compiled, context)
  const store = context.exports.useProfileStore()
  return { store, writes, synced, drafts, setUser: value => { user = value }, user: () => user, setGet: fn => { get = fn }, setPut: fn => { put = fn },
    setPost: fn => { post = fn }, setSync: fn => { sync = fn }, uploads: () => uploads, tick: vue.nextTick }
}

test('UX12 返回时串行补存最后输入，失败草稿可恢复且不保存凭据', async () => {
  const f=fixture();await f.store.loadProfile();f.store.profileDraft.nickname='第一份'
  const gate=deferred();f.setPut(async data=>{await gate.promise;return {data:{result:{...f.user(),...data}}}})
  const first=f.store.saveProfile();f.store.profileDraft.nickname='最后一字'
  const flush=f.store.flushProfile();gate.resolve();await first;assert.equal(await flush,true)
  assert.deepEqual(f.writes.map(x=>x.nickname),['第一份','最后一字']);assert.equal(f.drafts.size,0)
  f.store.profileDraft.nickname='离线草稿';f.setPut(async()=>{throw new Error('offline')})
  assert.equal(await f.store.flushProfile(),false);assert.equal(f.store.retainDraft(),true)
  assert.ok([...f.drafts.values()].every(value=>!value.includes('session-a')))
  await f.store.loadProfile();assert.equal(f.store.profileDraft.nickname,'离线草稿')
  f.store.$dispose()
})
test('空昵称和纯空白不保存或上传，保留草稿并说明未保存原因，改正后可保存', async () => {
  const f = fixture(); await f.store.loadProfile()
  for (const nickname of ['', '   ']) {
    f.store.profileDraft.nickname = nickname
    f.store.setAvatarPreview('aW1hZ2U=')
    assert.equal(f.store.nicknameError, '昵称不能为空')
    assert.equal(await f.store.saveProfile(), false)
    assert.equal(f.store.saveError, '昵称不能为空')
    assert.equal(f.store.hasUnsavedChanges, true)
    assert.equal(f.writes.length, 0); assert.equal(f.uploads(), 0); assert.equal(f.synced.length, 0)
  }
  f.store.profileDraft.nickname = '有效昵称'
  assert.equal(f.store.nicknameError, '')
  assert.equal(await f.store.saveProfile(), true)
  assert.equal(f.store.hasUnsavedChanges, false); f.store.$dispose()
})

test('保存回应只确认已提交内容，等待期间的新输入仍未保存', async () => {
  const f = fixture(); await f.store.loadProfile()
  const wait = deferred(); f.setPut(async data => { await wait.promise; return { data: { result: { ...f.user(), ...data } } } })
  f.store.profileDraft.nickname = '提交内容'
  const saving = f.store.saveProfile()
  f.store.profileDraft.nickname = '等待期间新输入'
  wait.resolve(); await saving
  assert.equal(f.writes[0].nickname, '提交内容')
  assert.equal(f.synced[0].nickname, '提交内容')
  assert.equal(f.store.profileDraft.nickname, '等待期间新输入')
  assert.equal(f.store.hasUnsavedChanges, true)
  f.store.$dispose()
})
test('保存期间改回本次提交值，成功后没有未保存标记', async () => {
  const f = fixture(); await f.store.loadProfile()
  const wait = deferred(); f.setPut(async data => { await wait.promise; return { data: { result: { ...f.user(), ...data } } } })
  f.store.profileDraft.nickname = '提交内容'
  const saving = f.store.saveProfile()
  f.store.profileDraft.nickname = '临时输入'
  f.store.profileDraft.nickname = '提交内容'
  wait.resolve(); await saving
  assert.equal(f.store.hasUnsavedChanges, false)
  f.store.$dispose()
})
test('保存失败保留草稿和未保存标记', async () => {
  const f = fixture(); await f.store.loadProfile()
  f.store.profileDraft.nickname = '修改'
  f.setPut(async () => { throw new Error('offline') })
  assert.equal(await f.store.saveProfile(), false)
  assert.equal(f.store.hasUnsavedChanges, true)
  assert.equal(f.synced.length, 0)
  f.store.$dispose()
})
test('加载期间换会话，旧资料不能与新账号混合', async () => {
  const f = fixture(); const wait = deferred()
  f.setGet(() => wait.promise)
  const loading = f.store.loadProfile()
  const previous = { ...f.user() }
  f.setUser({ ...previous, id: 'user-b', account: 'account-b', token: 'session-b' })
  wait.resolve({ data: { result: previous } }); await loading
  assert.notEqual(f.store.pageState, 'ready')
  assert.notEqual(f.store.profileDraft.token, 'session-b')
  f.store.$dispose()
})
test('保存期间退出，迟到回应不回写原生', async () => {
  const f = fixture(); await f.store.loadProfile()
  const wait = deferred(); f.setPut(() => wait.promise)
  f.store.profileDraft.nickname = '提交内容'
  const saving = f.store.saveProfile()
  f.setUser({ token: '' })
  wait.resolve({ data: { result: { nickname: '提交内容' } } }); await saving
  assert.equal(f.synced.length, 0)
  f.store.$dispose()
})

test('头像已上传但字段失败时保留已保存头像，重试不重复上传', async () => {
  const f = fixture(); await f.store.loadProfile()
  f.store.setAvatarPreview('aW1hZ2U='); f.store.profileDraft.nickname = '新昵称'
  f.setPut(async () => { throw new Error('offline') })
  assert.equal(await f.store.saveProfile(), false)
  assert.equal(f.store.pendingAvatarBase64, '')
  assert.equal(f.store.profileDraft.avatar, 'https://example.test/avatar.jpg')
  assert.equal(f.synced[0].nickname, '原昵称')
  assert.equal(f.store.hasUnsavedChanges, true)
  f.setPut(async data => ({ data: { result: { ...f.user(), ...data, avatar: 'https://example.test/avatar.jpg' } } }))
  assert.equal(await f.store.saveProfile(), true)
  assert.equal(f.uploads(), 1)
  assert.equal(f.store.hasUnsavedChanges, false)
  f.store.$dispose()
})
test('原生同步失败后只重试同步，不重复提交已确认字段', async () => {
  const f = fixture(); await f.store.loadProfile()
  f.store.profileDraft.nickname = '确认昵称'
  f.setSync(async () => { throw new Error('bridge') })
  assert.equal(await f.store.saveProfile(), false)
  assert.match(f.store.saveError, /同步失败/)
  f.setSync(async data => f.synced.push(data))
  assert.equal(await f.store.saveProfile(), true)
  assert.equal(f.writes.length, 1)
  assert.equal(f.store.hasUnsavedChanges, false)
  f.store.$dispose()
})
test('上传期间连续选图保留新预览，不被上一张回应覆盖', async () => {
  const f = fixture(), gate = deferred(); await f.store.loadProfile()
  f.setPost(() => gate.promise)
  f.store.setAvatarPreview('Zmlyc3Q=')
  const saving = f.store.saveProfile()
  f.store.setAvatarPreview('c2Vjb25k')
  gate.resolve({ data: { result: { avatar: 'https://example.test/first.jpg' } } }); await saving
  assert.equal(f.store.profileDraft.avatar, 'data:image/jpeg;base64,c2Vjb25k')
  assert.equal(f.store.pendingAvatarBase64, 'c2Vjb25k')
  assert.equal(f.store.hasUnsavedChanges, true)
  f.store.$dispose()
})
test('头像同步失败不会把尚未提交的昵称说成已保存', async () => {
  const f = fixture(); await f.store.loadProfile()
  f.store.setAvatarPreview('aW1hZ2U='); f.store.profileDraft.nickname = '未保存'
  f.setSync(async () => { throw new Error('bridge') })
  assert.equal(await f.store.saveProfile(), false)
  assert.match(f.store.saveError, /其余修改仍未保存/)
  assert.equal(f.writes.length, 0)
  f.store.$dispose()
})
