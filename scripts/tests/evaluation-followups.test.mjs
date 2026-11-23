import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluationFixture } from './evaluation-harness.mjs'
import { execute, pageMethods, sourceOf, tick } from './native-harness.mjs'

const root = 'mixed-development-h5/'

test('订单详情与评价页按资格显示追加处理后感受入口，追加提交体仅含 content 且追加后只读', async () => {
  const detailSource = sourceOf(root + 'features/cart/src/main/ets/presentation/views/OrderDetailView.ets')
  assert.match(detailSource, /evaluation\?\.canFollowup/)
  assert.match(detailSource, /追加处理后感受/)
  assert.match(detailSource, /买家追加 · /)

  const evalSource = sourceOf(root + 'features/cart/src/main/ets/presentation/views/EvaluationView.ets')
  assert.match(evalSource, /追加处理后感受/)
  assert.match(evalSource, /买家追加 · /)
  assert.match(evalSource, /处理记录待接入/)

  const calls = []
  const f = evaluationFixture()
  const Page = pageMethods(root + 'features/cart/src/main/ets/presentation/views/EvaluationView.ets', 'EvaluationView', {}, {
    ...execute(sourceOf(root + 'commons/models/src/main/ets/TimeFormat.ets')),
    orderWriteFailure: () => ({ unknownResult: false, message: 'fail' }),
    ...execute(sourceOf(root + 'commons/storage/src/main/ets/EvaluationValidation.ets')),
    ...execute(sourceOf(root + 'features/cart/src/main/ets/presentation/utils/EvaluationPresentation.ets')),
    ...execute(sourceOf(root + 'features/cart/src/main/ets/presentation/utils/EvaluationSubmitFlow.ets')),
    KeyboardAvoidMode: { RESIZE: 1 },
    PAGE_PATH: { EVALUATION_PAGE: 'evaluation' },
    auth: { getUserInfo: () => ({ id: 'a', token: 'a-token' }) },
    storeManager: { getStore: () => ({ getSync: () => '', putSync: () => {}, deleteSync: () => {}, flush: async () => {} }) },
    getOrderDetailAPI: async () => orderPayload,
    commentOrderAPI: async () => ({ id: 'order-a' }),
    RequestAxios: { postWithSession: async (...args) => { calls.push(args); return { orderId: 'order-a' } } },
    setTimeout: () => 1,
    clearTimeout: () => {},
  })

  let orderPayload = {
    id: 'order-a',
    canEvaluate: false,
    skus: [],
    evaluation: {
      orderId: 'order-a',
      score: 3,
      content: '原本的评价正文',
      createdAt: 1700000000000,
      canFollowup: true,
      followup: null,
      serviceRecord: { status: 'pending', connected: false, label: '处理记录待接入', records: [] }
    }
  }
  const page = new Page()
  page.user = { id: 'a', token: 'a-token' }
  page.getUIContext = () => ({ getKeyboardAvoidMode: () => 0, setKeyboardAvoidMode: () => {}, getPromptAction: () => ({ showToast: () => {} }) })
  page.stackPath = { getParamByName: () => ['order-a'], pop: () => {} }
  page.aboutToAppear()
  await tick()

  assert.equal(page.canSubmitFollowup(), true)
  // 4字和301字拒绝发送
  page.followupContent = '四字不行'
  await page.submitFollowup()
  assert.equal(calls.length, 0)
  page.followupContent = '好'.repeat(301)
  await page.submitFollowup()
  assert.equal(calls.length, 0)

  // 合法追加提交后重新加载，进入只读
  page.followupContent = '  售后处理到位，问题已解决  '
  orderPayload = {
    ...orderPayload,
    evaluation: {
      ...orderPayload.evaluation,
      canFollowup: false,
      followup: { content: '售后处理到位，问题已解决', createdAt: 1700001000000 }
    }
  }
  await page.submitFollowup()
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], '/member/order/order-a/evaluation/followup')
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1])), { content: '售后处理到位，问题已解决' })
  assert.equal(calls[0][2], 'a-token')
  assert.equal(page.canSubmitFollowup(), false)
  assert.equal(page.canEditEvaluation(), false)
  assert.equal(page.order.evaluation.content, '原本的评价正文')

  // canFollowup=false 时不可追加
  orderPayload = {
    ...orderPayload,
    evaluation: { ...orderPayload.evaluation, canFollowup: false, followup: null }
  }
  const locked = new Page()
  locked.user = { id: 'a', token: 'a-token' }
  locked.getUIContext = () => ({ getKeyboardAvoidMode: () => 0, setKeyboardAvoidMode: () => {}, getPromptAction: () => ({ showToast: () => {} }) })
  locked.stackPath = { getParamByName: () => ['order-a'], pop: () => {} }
  locked.aboutToAppear()
  await tick()
  assert.equal(locked.canSubmitFollowup(), false)
  locked.followupContent = '尝试越过资格提交追加'
  await locked.submitFollowup()
  assert.equal(calls.length, 1)
})

test('商品详情评价卡与商家评价管理只读展示买家追加与处理记录待接入文案', () => {
  const card = sourceOf(root + 'features/home/src/main/ets/presentation/components/GoodsComment.ets')
  assert.match(card, /买家追加 · /)
  assert.match(card, /formatReviewDate\(evaluation\.followup\.createTime\)/)
  assert.match(card, /处理记录待接入/)
  assert.doesNotMatch(card, /编辑追加|删除追加/)

  const merchant = sourceOf(root + 'features/mine/src/main/ets/presentation/views/ReviewManageView.ets')
  assert.match(merchant, /买家追加 · /)
  assert.match(merchant, /item\.followup\.content/)
  assert.match(merchant, /处理记录待接入/)
  assert.doesNotMatch(merchant, /编辑追加|删除追加|编写处理记录|evaluation_service_records/)
})
