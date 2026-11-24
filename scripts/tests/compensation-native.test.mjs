import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execute, sourceOf, pageMethods, deferred } from './native-harness.mjs'

const root = 'mixed-development-h5/'

function loadCompensationUtils() {
  const timeFormat = execute(sourceOf(root + 'commons/models/src/main/ets/TimeFormat.ets'))
  const compUtils = execute(
    sourceOf(root + 'features/cart/src/main/ets/presentation/utils/CompensationPresentation.ets'),
    { models: { ...timeFormat } }
  )
  return { timeFormat, compUtils }
}

test('OrderDetailView 补差草稿区块、双向 bindSheet 与主题配色规范', () => {
  const source = sourceOf(root + 'features/cart/src/main/ets/presentation/views/OrderDetailView.ets')
  assert.match(source, /\/buyer\/orders\/'\s*\+\s*encodeURIComponent\(orderId\)\s*\+\s*'\/compensation\/drafts/)
  assert.match(source, /RequestAxios\.postWithSession<CompensationReceipt>\('\/buyer\/compensation\/confirm',\s*input,\s*token\)/)
  assert.match(source, /\/buyer\/compensation\/receipts\/'\s*\+\s*encodeURIComponent\(receiptId\)/)
  assert.match(source, /\.bindSheet\(\$\$this\.compensationDetailVisible,\s*this\.CompensationDetailSheet\(\)/)
  assert.match(source, /\.bindSheet\(\$\$this\.receiptVisible,\s*this\.CompensationReceiptSheet\(\)/)
  assert.match(source, /\$r\('\[ui_components\]\.color\.red'\)/)
  assert.match(source, /\$r\('\[ui_components\]\.color\.on_primary'\)/)
})

test('OrderDetailView 拉取草稿、一键确认、403/400/409 中文错误恢复与账号切换隔离', async () => {
  const { timeFormat, compUtils } = loadCompensationUtils()
  const postCalls = []
  const draft = {
    draftId: 'draft-1',
    orderId: 'order-1',
    policyId: 'policy-1',
    policyVersion: 2,
    windowDays: 7,
    budgetPerOrderCents: 2000,
    basketDeltaCents: 1500,
    cappedCents: 1500,
    perLine: [{ order_line_id: 'sku-1', delta_cents: 1500 }],
    createdAt: Date.now() - 1000,
    expiresAt: Date.now() + 86_400_000,
    status: 'pending'
  }
  let confirmImpl = async (url, data, token) => {
    postCalls.push({ url, data, token })
    return {
      receiptId: 'receipt-1',
      draftId: 'draft-1',
      orderId: 'order-1',
      policyId: 'policy-1',
      policyVersion: 2,
      windowDays: 7,
      confirmedCents: 1500,
      confirmedAt: Date.now(),
      channelStatus: 'pending',
      channelRef: null,
      statusLabel: '补差已登记，渠道处理中'
    }
  }
  const orderPres = execute(
    sourceOf(root + 'features/cart/src/main/ets/presentation/utils/OrderPresentation.ets'),
    {
      models: { OrderState: { AWAITING_SHIPMENT: 2, COMPLETED: 5 }, ...timeFormat },
      '@kit.BasicServicesKit': { systemDateTime: { getUptime: () => 0, TimeType: { STARTUP: 0 } } }
    }
  )

  const gate = deferred()
  const Page = pageMethods(
    root + 'features/cart/src/main/ets/presentation/views/OrderDetailView.ets',
    'OrderDetailView',
    {
      models: { ...timeFormat },
      '../utils/CompensationPresentation': compUtils,
      '../utils/OrderPresentation': orderPres
    },
    {
      ...timeFormat,
      ...compUtils,
      ...orderPres,
      OrderState: { AWAITING_SHIPMENT: 2, COMPLETED: 5 },
      util: { generateRandomUUID: () => 'req-uuid-1' },
      RequestAxios: {
        getForSession: async (url) => {
          if (url.includes('/compensation/drafts')) return gate.promise
          if (url.includes('/compensation/receipts/')) return {
            receiptId: 'receipt-1', draftId: 'draft-1', orderId: 'order-1', policyId: 'policy-1',
            policyVersion: 2, windowDays: 7, confirmedCents: 1500, confirmedAt: Date.now(),
            channelStatus: 'unknown', channelRef: null, statusLabel: '待执行（渠道结果待核实）'
          }
          throw new Error('unexpected url ' + url)
        },
        postWithSession: (...args) => confirmImpl(...args)
      }
    }
  )

  const page = new Page()
  page.pageActive = true
  page.orderId = 'order-1'
  page.detailOrderId = 'order-1'
  page.detailToken = 'tok-b1'
  page.detailAccountId = 'b1'
  page.detailIdentity = 'buyer'
  page.detailIdentityRevision = 1
  page.user = { id: 'b1', token: 'tok-b1', identity: 'buyer', identityRevision: 1 }
  page.order = { id: 'order-1', orderState: 2 }
  page.loading = false
  page.loadFailed = false
  page.loadOrderDetail = async () => {}

  // 1) 一键确认成功 -> 发送固定契约体并展示非到账处理中状态与回执编号
  await page.confirmCompensationDraft(draft)
  assert.equal(postCalls.length, 1)
  assert.equal(postCalls[0].url, '/buyer/compensation/confirm')
  assert.equal(postCalls[0].token, 'tok-b1')
  assert.deepEqual(JSON.parse(JSON.stringify(postCalls[0].data)), { draftId: 'draft-1', requestKey: 'req-uuid-1', confirmedCents: 1500 })
  assert.match(page.compensationMessage, /补差已登记，渠道处理中/)
  assert.match(page.compensationMessage, /receipt-1/)

  // 2) 查看回执展示渠道 unknown 待核实文案
  await page.openCompensationReceipt('receipt-1')
  assert.equal(page.receiptVisible, true)
  assert.equal(page.selectedReceipt.channelStatus, 'unknown')
  assert.equal(page.selectedReceipt.statusLabel, '待执行（渠道结果待核实）')

  // 3) 403 / 409 错误处理
  confirmImpl = async () => { const err = new Error('expired'); err.httpStatus = 403; throw err }
  await page.confirmCompensationDraft(draft)
  assert.match(page.compensationMessage, /过期/)

  confirmImpl = async () => { const err = new Error('balance'); err.httpStatus = 409; throw err }
  await page.confirmCompensationDraft(draft)
  assert.match(page.compensationMessage, /余额/)

  confirmImpl = async () => {
    const err = new Error('changed')
    err.httpStatus = 409
    err.response = { status: 409, data: { reason: 'COMPENSATION_CONDITION_CHANGED' } }
    throw err
  }
  await page.confirmCompensationDraft(draft)
  assert.match(page.compensationMessage, /重算/)

  // 4) 迟到草稿响应在切号后不写入当前页面
  page.compensationDrafts = []
  const loadingDrafts = page.loadCompensationDrafts('order-1', 'tok-b1', page.pageGeneration, page.querySequence)
  page.user = { id: 'b2', token: 'tok-b2', identity: 'buyer', identityRevision: 1 }
  gate.resolve([draft])
  await loadingDrafts
  assert.equal(page.compensationDrafts.length, 0)
})
