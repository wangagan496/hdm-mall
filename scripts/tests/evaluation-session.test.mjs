import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deferred, tick } from './native-harness.mjs'
import { evaluationFixture } from './evaluation-harness.mjs'

const userB = { id: 'b', token: 'b-token' }
const eligible = id => ({ id, canEvaluate: true, skus: [] })
const fill = (page, content = '这是当前账号的评价') => { page.content = content; page.setScore(4) }

test('评价切换账号清空旧订单和输入，恢复本人草稿且旧查询不回写', async () => {
  for (const failed of [false, true]) {
    const f = evaluationFixture(), old = deferred(), current = deferred()
    f.saved.set('evaluation-draft:b:order-a', JSON.stringify({ score: 3, content: '乙账号保存的评价' }))
    f.setLoad(() => old.promise)
    const page = f.newPage(); page.aboutToAppear(); fill(page, '甲账号未落盘的内容')
    f.setLoad(() => current.promise); f.switchUser(userB)
    assert.equal(page.content, '乙账号保存的评价'); assert.equal(page.score, 3)
    assert.equal(page.order, null); assert.equal(page.loading, true)
    assert.equal(JSON.parse(f.saved.get('evaluation-draft:a:order-a')).content, '甲账号未落盘的内容')
    if (failed) old.reject(new Error('old failure')); else old.resolve(eligible('old-order'))
    await tick(); assert.equal(page.order, null); assert.equal(page.loading, true); assert.equal(page.loadFailed, false)
    current.resolve(eligible('order-a')); await tick(); assert.equal(page.order.id, 'order-a')
    assert.deepEqual(f.queries.map(args => args[1]), ['a-token', 'b-token'])
    const count = f.queries.length; f.switchUser({ ...userB, nickname: 'new name' }); await tick()
    assert.equal(f.queries.length, count)
    f.switchUser({}); await tick(); assert.equal(page.order, null); assert.equal(page.content, '')
    assert.equal(page.loading, false); assert.equal(f.queries.length, count); assert.equal(f.timers.size, 0)
    page.setScore(2); page.toggleTag('质量很好'); await page.submitEvaluation()
    assert.equal(page.score, 5); assert.equal(page.content, ''); assert.equal(f.submissions.length, 0)
  }
})

test('旧评价提交成功或失败不能清除重进页面草稿、释放新提交锁或跳转', async () => {
  for (const accountChange of [false, true]) for (const failed of [false, true]) {
    const f = evaluationFixture(), page = f.newPage(), old = deferred(), current = deferred()
    page.aboutToAppear(); await tick(); fill(page, '旧页面提交的内容')
    f.setSubmit(() => old.promise); const pending = page.submitEvaluation()
    page.aboutToDisappear()
    if (accountChange) f.setUser(userB)
    f.setOrderId('order-b'); page.aboutToAppear(); await tick()
    fill(page, '新页面独立的内容'); page.saveDraft()
    f.setSubmit(() => current.promise); const next = page.submitEvaluation()
    assert.equal(page.submitting, true)
    const key = `evaluation-draft:${accountChange ? 'b' : 'a'}:order-b`
    const queries = f.queries.length
    if (failed) old.reject(new Error('old failure')); else old.resolve({ id: 'order-a' })
    await pending
    assert.equal(page.submitting, true); assert.equal(page.submitted, false); assert.equal(page.errorText, '')
    assert.equal(JSON.parse(f.saved.get(key)).content, '新页面独立的内容')
    assert.equal(f.navigations(), 0); assert.equal(f.queries.length, queries, 'stale write failure must not start confirmation')
    current.resolve({ id: 'order-b' }); await next
    assert.equal(page.submitted, true); assert.equal(f.saved.has(key), false); assert.equal(f.navigations(), 1)
  }
})

test('已开始的评价结果确认在同账号同订单重进后也不能删除新草稿', async () => {
  const f = evaluationFixture(), page = f.newPage(), confirmation = deferred()
  page.aboutToAppear(); await tick(); fill(page, '前次提交待确认的内容')
  f.setSubmit(async () => { throw new Error('response lost') })
  f.setLoad(() => confirmation.promise); const pending = page.submitEvaluation(); await tick()
  page.aboutToDisappear(); f.setLoad(async () => eligible('order-a')); page.aboutToAppear(); await tick()
  fill(page, '重新进入后编辑的内容'); page.saveDraft()
  confirmation.resolve({ id: 'order-a', evaluation: { score: 4, content: '前次提交待确认的内容' } })
  await pending
  assert.equal(page.submitted, false); assert.equal(f.navigations(), 0)
  assert.equal(JSON.parse(f.saved.get('evaluation-draft:a:order-a')).content, '重新进入后编辑的内容')
  assert.deepEqual(f.queries[1], ['order-a', 'a-token'])
})

test('草稿旧计时器和迟到写盘失败不能写入或提示到新页面', async () => {
  const f = evaluationFixture(), page = f.newPage(), flush = deferred()
  page.aboutToAppear(); await tick(); fill(page, '旧页面的草稿内容')
  const oldTimer = [...f.timers.values()][0]
  f.setFlush(() => flush.promise); page.saveDraft(); page.aboutToDisappear()
  f.setFlush(async () => {}); f.setUser(userB); f.setOrderId('order-b'); page.aboutToAppear(); await tick()
  page.content = '尚未安排保存的新内容'
  oldTimer(); flush.reject(new Error('old disk failure')); await tick()
  assert.equal(f.saved.has('evaluation-draft:b:order-b'), false)
  assert.equal(page.errorText, ''); assert.equal(f.messages.length, 0)
  f.failFlush(); f.setFlush(async () => { throw new Error('current disk failure') }); page.saveDraft(); await tick()
  assert.match(page.errorText, /草稿保存失败/); assert.equal(f.messages.length, 1)
})

test('同实例换订单恢复独立初始草稿，已提交标记不删除后续订单输入', async () => {
  const f = evaluationFixture(), page = f.newPage()
  page.aboutToAppear(); await tick(); fill(page, '首个订单评价内容')
  await page.submitEvaluation(); page.aboutToDisappear()
  f.setOrderId('order-b'); page.aboutToAppear(); await tick()
  assert.equal(page.score, 5); assert.equal(page.content, ''); assert.equal(page.submitted, false)
  fill(page, '另一订单需要保存的草稿'); page.aboutToDisappear(); await tick()
  assert.equal(JSON.parse(f.saved.get('evaluation-draft:a:order-b')).content, '另一订单需要保存的草稿')
  assert.equal(f.keyboardMode(), 0)
})

test('隐藏评价页不查询或提交，重新显示后重读且资格恢复清除过期提示', async () => {
  const f = evaluationFixture(), page = f.newPage()
  f.setLoad(async () => ({ ...eligible('order-a'), canEvaluate: false }))
  page.aboutToAppear(); await tick(); assert.match(page.errorText, /暂不能评价/)
  f.setLoad(async () => eligible('order-a')); await page.loadOrderForEvaluation()
  assert.equal(page.errorText, '')
  page.aboutToDisappear(); const count = f.queries.length
  await page.loadOrderForEvaluation(); await page.submitEvaluation()
  assert.equal(f.queries.length, count); assert.equal(f.submissions.length, 0)
  page.aboutToAppear(); await tick(); assert.equal(f.queries.length, count + 1)
})

test('当前评价确认期间保持提交锁，确认读取固定凭证并拒绝不同结果', async () => {
  const f = evaluationFixture(), page = f.newPage(), confirmation = deferred()
  page.aboutToAppear(); await tick(); fill(page)
  f.setSubmit(async () => { throw Object.assign(new Error('response lost'), { isAxiosError: true }) }); f.setLoad(() => confirmation.promise)
  const pending = page.submitEvaluation(); await tick(); await page.submitEvaluation()
  assert.equal(f.submissions.length, 1); assert.equal(page.submitting, true)
  assert.equal(f.submissions[0][2], 'a-token'); assert.deepEqual(f.queries.at(-1), ['order-a', 'a-token'])
  confirmation.resolve({ id: 'order-a', evaluation: { score: 1, content: '另一条评价' } }); await pending
  assert.equal(page.submitted, false); assert.equal(page.submitting, false); assert.equal(f.navigations(), 0)
  assert.equal(page.content, '这是当前账号的评价')
  assert.equal(page.errorText, '网络连接失败，评价结果待确认，输入已保留，请恢复网络后重新提交')
})
