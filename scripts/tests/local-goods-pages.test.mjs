import { test as nodeTest } from 'node:test'
import assert from 'node:assert/strict'
import { deferred, execute, sourceOf, tick, pageMethods } from './native-harness.mjs'

const test = (name, run) => nodeTest(name, { timeout: 2500 }, run)
const base = 'mixed-development-h5/features/mine/src/main/ets/presentation/'
const item = { id: 'same-goods', name: '商品', picture: 'picture', price: '19' }
function fixture(kind) {
  const name = kind === 'favorites' ? 'FavoritesView' : 'HistoryView'
  const list = kind === 'favorites' ? 'favoriteGoods' : 'browsedGoods'
  const load = kind === 'favorites' ? 'loadLocalFavorites' : 'loadLocalHistory'
  const remove = kind === 'favorites' ? 'removeFavoriteAndRefresh' : 'removeHistoryAndRefresh'
  let user = { token: 'token-a', account: 'account-a' }, records = [{ ...item }], mutation = async () => {}, readError = false
  const writes = [], reads = [], messages = []
  let source = sourceOf(base + 'views/' + name + '.ets')
  source = source.slice(source.indexOf('export struct ' + name), source.indexOf('  build()'))
  source = source.replace(/  @Builder\n  \w+\(\) \{[\s\S]*?\n  \}\n/g, '')
    .replace('export struct', 'export class').replace(/@\w+\s*(?:\([^)]*\))?\s*/g, '') + '\n}'
  const read = () => { reads.push(user.token); if (readError) throw new Error('storage unavailable'); return records }
  const write = (action, ...args) => { writes.push([action, ...args, user.token]); return mutation() }
  const View = execute(source, {}, {
    auth: { getUserInfo: () => user }, localGoodsStore: { getFavorites: read, getHistory: read,
      removeFavorite: id => write('favorite', id), removeHistory: id => write('history', id), clearHistory: () => write('clear') },
  })[name]
  const page = new View(); page.user = user
  page.getUIContext = () => ({ getPromptAction: () => ({ showToast: value => messages.push(value.message) }) })
  const open = () => {
    if (page.openClearDialog) page.openClearDialog(); else page.showClearDialog = true
    return page.createClearAction ? page.createClearAction() : () => page.clearHistoryAndRefresh()
  }
  return { page, list, load, remove, writes, reads, messages, open,
    appear: () => page.aboutToAppear(), setRecords: value => { records = value }, setReadError: value => { readError = value },
    setMutation: fn => { mutation = fn }, setUser: (value, notify = true) => {
      user = value; if (notify) { page.user = value; page.reloadForCurrentAccount?.() }
    } }
}

test('收藏和足迹读取失败显示重试并禁止操作，重读成功后恢复', async () => {
  for (const kind of ['favorites', 'history']) {
    const f = fixture(kind); f.appear(); f.setReadError(true); f.page[f.load]()
    assert.equal(f.page.loaded, false); assert.match(f.page.errorText, /读取失败/)
    assert.equal(f.page[f.list].length, 1)
    await f.page[f.remove](item.id); if (kind === 'history') f.open()()
    assert.equal(f.writes.length, 0)
    f.setReadError(false); f.setRecords([]); f.page[f.load]()
    assert.equal(f.page.loaded, true); assert.equal(f.page.errorText, ''); assert.equal(f.page[f.list].length, 0)
  }
})

test('收藏和足迹账号切换立即替换列表，监听前旧操作不写新账号', async () => {
  for (const kind of ['favorites', 'history']) {
    const f = fixture(kind); f.appear(); f.setUser({ token: 'token-b', account: 'account-b' }, false)
    await f.page[f.remove](item.id)
    if (kind === 'history') await f.open()()
    assert.equal(f.writes.length, 0, kind)
    f.setRecords([{ ...item, name: '新账号商品' }]); f.setUser({ token: 'token-b', account: 'account-b' })
    assert.equal(f.page[f.list][0].name, '新账号商品')
    const count = f.reads.length; f.setUser({ token: 'token-b', account: 'account-b', nickname: 'new' })
    assert.equal(f.reads.length, count)
    f.setRecords([]); f.setUser({ token: '', account: '' }); assert.equal(f.page[f.list].length, 0)
  }
})

test('收藏和足迹删除只允许当前列表且连续点击不重复写入', async () => {
  for (const kind of ['favorites', 'history']) {
    const f = fixture(kind), gate = deferred(); f.appear()
    await f.page[f.remove]('missing'); assert.equal(f.writes.length, 0)
    f.setMutation(() => gate.promise); const first = f.page[f.remove](item.id), duplicate = f.page[f.remove](item.id)
    assert.equal(f.writes.length, 1)
    if (kind === 'history') { f.open()(); assert.equal(f.writes.length, 1); assert.equal(f.page.showClearDialog, false) }
    f.setRecords([]); gate.resolve(); await first; await duplicate
    assert.equal(f.page[f.list].length, 0)
  }
})

test('收藏和足迹旧删除成功失败不能刷新重进页面、提示或释放新操作锁', async () => {
  for (const kind of ['favorites', 'history']) for (const change of ['reenter', 'account']) for (const failed of [false, true]) {
    const f = fixture(kind), old = deferred(), current = deferred(); f.appear()
    f.setMutation(() => old.promise); const first = f.page[f.remove](item.id)
    f.page.aboutToDisappear?.()
    if (change === 'account') f.setUser({ token: 'token-b', account: 'account-b' })
    f.appear(); f.setMutation(() => current.promise); const second = f.page[f.remove](item.id)
    assert.equal(f.writes.length, 2)
    const count = f.reads.length
    if (failed) old.reject(new Error('old')); else old.resolve()
    await first; assert.equal(f.page.removing, true); assert.equal(f.reads.length, count); assert.equal(f.messages.length, 0)
    current.resolve(); await second; assert.equal(f.page.removing, false)
  }
})

test('足迹旧清空确认在换账号、重进、刷新、取消和新确认框出现后失效', async () => {
  for (const change of ['account', 'reenter', 'refresh', 'cancel', 'replace']) {
    const f = fixture('history'); f.appear(); const old = f.open()
    if (change === 'account') f.setUser({ token: 'token-b', account: 'account-b' })
    if (change === 'reenter') { f.page.aboutToDisappear?.(); f.appear() }
    if (change === 'refresh') f.page[f.load]()
    if (change === 'cancel') { if (f.page.createCancelClearAction) f.page.createCancelClearAction()(); else f.page.showClearDialog = false }
    if (change === 'replace') f.open()
    await old(); await tick(); assert.equal(f.writes.length, 0, change)
    const current = f.open(); await current(); await tick(); await current(); await tick()
    assert.equal(f.writes.length, 1, change)
  }
})

test('足迹旧清空成功失败不关闭新确认框或解除新清空等待', async () => {
  for (const failed of [false, true]) {
    const f = fixture('history'), old = deferred(), current = deferred(); f.appear()
    f.setMutation(() => old.promise); f.open()(); assert.equal(f.writes.length, 1)
    f.page.aboutToDisappear?.(); f.appear(); const confirm = f.open()
    const count = f.reads.length
    if (failed) old.reject(new Error('old')); else old.resolve()
    await tick(); assert.equal(f.page.showClearDialog, true); assert.equal(f.reads.length, count); assert.equal(f.messages.length, 0)
    f.setMutation(() => current.promise); confirm(); assert.equal(f.page.clearing, true)
    await f.page[f.remove](item.id); assert.equal(f.writes.length, 2)
    f.setRecords([]); current.resolve(); await tick(); assert.equal(f.page.clearing, false); assert.equal(f.page[f.list].length, 0)
  }
})

test('隐藏收藏足迹不读写，返回和前台刷新能看到其他页面的最新记录', async () => {
  for (const kind of ['favorites', 'history']) {
    const f = fixture(kind); f.appear(); const count = f.reads.length
    f.page.aboutToDisappear?.(); f.page[f.load](); await f.page[f.remove](item.id); f.page.refreshAfterForeground?.()
    assert.equal(f.reads.length, count); assert.equal(f.writes.length, 0)
    f.setRecords([{ ...item, name: '已更新' }]); f.page.showLocalGoods(); assert.equal(f.page[f.list][0].name, '已更新')
    f.setRecords([]); f.page.refreshAfterForeground(); assert.equal(f.page[f.list].length, 0)
  }
})

test('本地删除失败保留列表并释放锁，清空失败需要重新确认后才能重试', async () => {
  for (const kind of ['favorites', 'history']) {
    const f = fixture(kind); f.appear(); f.setMutation(async () => { throw new Error('disk') })
    await f.page[f.remove](item.id); assert.equal(f.page[f.list].length, 1); assert.equal(f.page.removing, false)
    assert.equal(f.messages.length, 1)
    f.setMutation(async () => { f.setRecords([]) }); await f.page[f.remove](item.id); assert.equal(f.page[f.list].length, 0)
  }
  const f = fixture('history'); f.appear(); f.setMutation(async () => { throw new Error('disk') })
  const confirm = f.open(); await confirm(); await tick(); await confirm(); await tick()
  assert.equal(f.writes.length, 1); assert.equal(f.page[f.list].length, 1); assert.equal(f.page.clearing, false)
  f.setMutation(async () => { f.setRecords([]) }); f.open()(); await tick(); assert.equal(f.page[f.list].length, 0)
})

test('旧列表行回调不能删除或打开新会话商品，匿名本地记录仍可管理', async () => {
  for (const kind of ['favorites', 'history']) {
    const f = fixture(kind); f.appear()
    const action = f.page.createRemoveAction ? f.page.createRemoveAction(item.id) : id => f.page[f.remove](id)
    const guard = f.page.createRowGuard ? f.page.createRowGuard(item.id) : () => true
    f.setUser({ token: 'token-b', account: 'account-b' }); action(item.id); await tick()
    assert.equal(f.writes.length, 0); assert.equal(guard(), false)
    const Row = pageMethods(base + 'components/LocalGoodsRow.ets', 'LocalGoodsRow', {}, { PAGE_PATH: { GOODS_PAGE: 'goods' } })
    const row = new Row(), paths = []; row.item = item; row.canOpen = guard; row.stackPath = { pushPath: value => paths.push(value) }
    row.openGoods(); assert.equal(paths.length, 0)
    f.setUser({ token: '', account: '' }); f.setRecords([{ ...item }]); f.page[f.load]()
    const guestGuard = f.page.createRowGuard(item.id); row.canOpen = guestGuard; row.openGoods(); assert.equal(paths.length, 1)
    await f.page[f.remove](item.id); assert.equal(f.writes.at(-1).at(-1), '')
  }
})
