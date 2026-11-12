import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pageMethods, sourceOf, execute, deferred, tick } from './native-harness.mjs'
import { evaluationFixture } from './evaluation-harness.mjs'
import { BusinessError } from './order-write-boundaries.mjs'

const cartViews = 'mixed-development-h5/features/cart/src/main/ets/presentation/views/'
const mineViews = 'mixed-development-h5/features/mine/src/main/ets/presentation/views/'
const checkout = () => {
  let sequence = 0
  const Page = pageMethods(cartViews + 'CheckView.ets', 'CheckView', {}, {
    ...execute(sourceOf('mixed-development-h5/commons/models/src/main/ets/InvoiceModels.ets')),
    CheckoutSheet: { None: 0 }, GlobalVariable: { DEMO_ORDER_FLOW: false },
    util: { generateRandomUUID: () => 'request-' + ++sequence }
  })
  const page = new Page()
  page.addressId = 'address'; page.goodsList = [{ skuId: 'sku', count: 1 }]
  page.summary.totalPayPrice = 29
  return page
}

test('开票选填，单位抬头提交规范税号与邮箱，改动开票信息换下单编号', () => {
  const page = checkout()
  assert.equal(page.buildOrderRequest().invoice, undefined)
  page.invoiceEnabled = true
  page.invoiceDraft = { titleType: 'company', title: ' 惠多美测试单位 ', taxId: '91310000123456789a', email: ' invoice@example.test ' }
  const first = page.buildOrderRequest()
  assert.ok(first.invoice, '结算请求必须包含选填的开票信息')
  assert.deepEqual(JSON.parse(JSON.stringify(first.invoice)), { titleType: 'company', title: '惠多美测试单位', taxId: '91310000123456789A', email: 'invoice@example.test' })
  page.invoiceDraft = { ...page.invoiceDraft, email: 'changed@example.test' }
  assert.notEqual(page.buildOrderRequest().requestKey, first.requestKey)
})

test('结算拒绝缺税号或无效邮箱，个人开票不传旧税号', async () => {
  const page = checkout()
  let submitted = 0
  page.canSubmitOrder = () => true
  page.createOrderAndOpenCashier = async () => submitted++
  page.safeToast = () => {}
  page.invoiceEnabled = true
  page.invoiceDraft = { titleType: 'company', title: '单位', taxId: '', email: 'valid@example.test' }
  await page.submitCheckout()
  assert.equal(submitted, 0, '单位缺税号不能下单')
  page.invoiceDraft = { titleType: 'individual', title: '个人', taxId: 'bad', email: 'bad' }
  await page.submitCheckout()
  assert.equal(submitted, 0, '无效邮箱不能下单')
  page.invoiceDraft.email = 'valid@example.test'
  assert.equal(page.buildOrderRequest().invoice.taxId, undefined)
  await page.submitCheckout()
  assert.equal(submitted, 1)
})

test('订单完成后仅下单人补登记，买家显示服务端已开票状态', async () => {
  const calls = []
  const Page = pageMethods(cartViews + 'OrderDetailView.ets', 'OrderDetailView', {}, {
    ...execute(sourceOf('mixed-development-h5/commons/models/src/main/ets/InvoiceModels.ets')),
    RequestAxios: { putForSession: async (...args) => { calls.push(args); return { ...args[1], status: 'requested', number: '' } } }
  })
  const page = new Page()
  page.user = { account: 'buyer', token: 'token' }; page.detailToken = 'token'; page.orderId = page.detailOrderId = 'order'
  page.order = { id: 'order', ownerAccount: 'buyer', orderState: 4 }; page.loading = false
  assert.equal(typeof page.saveInvoice, 'function', '订单详情应能补登记开票')
  page.invoiceDraft = { titleType: 'individual', title: '个人', email: 'me@example.test' }
  await page.saveInvoice()
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], '/member/order/order/invoice')
  assert.equal(page.order.invoice.status, 'requested')
  page.order = { id: 'order', ownerAccount: 'other', orderState: 4 }
  await page.saveInvoice()
  assert.equal(calls.length, 1)
  assert.match(sourceOf(cartViews + 'OrderDetailView.ets'), /已开票/)
})

test('商家标记开票防重，未知结果沿用编号，迟到结果不串账号', async () => {
  const calls = [], pending = deferred()
  const Page = pageMethods(mineViews + 'MerchantOrderView.ets', 'MerchantOrderView', {}, {
    util: { generateRandomUUID: () => 'key' },
    RequestAxios: { postWithSession: (...args) => { calls.push(args); return pending.promise } }
  })
  const page = new Page()
  page.active = true; page.user = { token: 't', role: 'merchant' }; page.orderId = 'order'
  page.order = { id: 'order', orderState: 2, invoice: { status: 'requested' } }
  assert.equal(typeof page.issueInvoice, 'function', '商家应能标记已开票')
  const first = page.issueInvoice()
  await page.issueInvoice()
  assert.equal(calls.length, 1)
  page.user = { token: 'new', role: 'merchant' }; page.order = null
  pending.resolve({ status: 'issued' }); await first
  assert.equal(page.order, null)
})

test('隐藏评价显示原因并预填，原文不能重发，改后可发布', async () => {
  const fixture = evaluationFixture()
  fixture.setLoad(async () => ({ id: 'order-a', canEvaluate: true, evaluation: { score: 3, content: '旧评价', hiddenReason: '广告' } }))
  const page = fixture.newPage(); page.aboutToAppear(); await tick()
  assert.match(page.errorText, /已被商家隐藏：广告/)
  assert.equal(page.content, '旧评价')
  await page.submitEvaluation()
  assert.equal(fixture.submissions.length, 0)
  assert.match(page.errorText, /修改/)
  page.content = '修改后的实际使用体验'; await page.submitEvaluation()
  assert.equal(fixture.submissions.length, 1)
  assert.equal(page.submitted, true)
})

test('隐藏的同文评价不能当作未知提交已成功，不覆盖修改草稿', async () => {
  const fixture = evaluationFixture(), page = fixture.newPage()
  page.aboutToAppear(); await tick(); page.content = '本次评价文字'; page.score = 4
  fixture.setSubmit(async () => { throw Object.assign(new Error('lost'), { isAxiosError: true }) })
  fixture.setLoad(async () => { throw new Error('offline') }); await page.submitEvaluation()
  fixture.setLoad(async () => ({ id: 'order-a', canEvaluate: true, evaluation: { score: 4, content: '本次评价文字', hiddenReason: '无关内容' } }))
  await page.refreshEvaluationResult()
  assert.equal(page.submitted, false, '隐藏状态不能误报发布成功')
  assert.equal(page.content, '本次评价文字')
  assert.match(page.errorText, /隐藏/)
})

test('商家商品评价入口只带商品编号，隐藏与头像重置必须选择原因', async () => {
  assert.match(sourceOf(mineViews + 'ProductManageView.ets'), /ReviewManageView/, '商品管理缺少评价处理入口')
  const calls = []
  const Page = pageMethods(mineViews + 'ReviewManageView.ets', 'ReviewManageView', {}, {
    RequestAxios: { postWithSession: async (...args) => calls.push(args) }
  })
  const page = new Page()
  page.active = true; page.user = { token: 't', role: 'merchant' }; page.load = async () => {}
  page.selected = { id: 'order', buyerId: 'buyer', avatar: '/uploads/avatar' }; page.action = 'hide'
  await page.submit(); assert.equal(calls.length, 0)
  page.reason = '广告'; await page.submit()
  assert.equal(calls[0][0], '/merchant/reviews/order/hide')
  assert.equal(calls[0][1].reason, '广告')
  page.selected = { id: 'order', buyerId: 'buyer', avatar: '/uploads/avatar' }; page.action = 'avatar'; page.reason = '泄露隐私'
  await page.submit()
  assert.equal(calls[1][0], '/merchant/members/buyer/avatar/reset')
  assert.match(sourceOf('mixed-development-h5/products/phone/src/main/ets/pages/Index.ets'), /ReviewManageView\(\)/)
})

test('客服留言关联当前订单，空文和超长不发送，未知结果重试不换编号', async () => {
  const calls = []
  let fail = true, key = 0
  const Page = pageMethods(mineViews + 'CustomerServiceView.ets', 'CustomerServiceView', {}, {
    util: { generateRandomUUID: () => 'key-' + ++key }, checkoutFailure: () => ({ status: 0 }),
    RequestAxios: { postWithSession: async (...args) => { calls.push(args); if (fail) throw new Error('offline'); return { id: 1 } } }
  })
  const page = new Page()
  page.active = true; page.user = { token: 'buyer-token', id: 'buyer', role: 'buyer' }; page.orderId = 'order'; page.load = async () => {}
  assert.equal(typeof page.send, 'function', '客服页必须发送真实留言')
  page.content = ' '; await page.send(); assert.equal(calls.length, 0)
  page.content = '字'.repeat(501); await page.send(); assert.equal(calls.length, 0)
  page.content = '请问这笔订单何时发货？'; await page.send()
  assert.equal(calls[0][0], '/member/service/messages')
  assert.equal(calls[0][1].orderId, 'order'); assert.equal(calls[0][2], 'buyer-token')
  assert.equal(page.pending, true)
  fail = false; await page.send()
  assert.equal(calls[0][1].requestKey, calls[1][1].requestKey)
  assert.equal(page.content, ''); assert.equal(page.pending, false)
})

test('客服历史按时间显示，已读只标记已加载消息，换账号拒绝迟到响应', async () => {
  const read = [], late = deferred()
  let slow = false
  const Page = pageMethods(mineViews + 'CustomerServiceView.ets', 'CustomerServiceView', {}, {
    RequestAxios: {
      getForSession: async () => slow ? late.promise : { items: [{ id: 1, sender: 'buyer' }, { id: 2, sender: 'merchant' }], hasMore: true, beforeId: 1 },
      postWithSession: async (...args) => { read.push(args); return { count: 0 } }
    }
  })
  const page = new Page(); page.active = true; page.user = { token: 't', id: 'buyer', role: 'buyer' }
  assert.equal(typeof page.load, 'function', '客服页必须读取真实历史')
  await page.load(); assert.equal(page.items.length, 2); assert.equal(read[0][1].throughId, 2)
  slow = true; const old = page.load(); page.user = { token: 'other', id: 'other', role: 'buyer' }; page.active = false; page.accountChanged()
  late.resolve({ items: [{ id: 3 }], hasMore: false }); await old
  assert.equal(page.items.length, 0); assert.equal(read.length, 1)
})

test('客服入口红点使用未读数，返回刷新且切换账号清除', async () => {
  const late = deferred()
  const Page = pageMethods(mineViews + 'MineView.ets', 'MineView', {}, {
    RequestAxios: { getForSession: () => late.promise }
  })
  const page = new Page(); page.user = { token: 't', id: 'buyer', role: 'buyer' }; page.attentionVisible = true; page.attentionToken = 't'
  assert.equal(typeof page.refreshServiceUnread, 'function', '我的页面必须查询客服未读数')
  const first = page.refreshServiceUnread('t', 0); late.resolve({ count: 2 }); await first
  assert.equal(page.serviceUnread, 2)
  assert.match(sourceOf(mineViews + 'MineView.ets'), /service-unread/)
  assert.match(sourceOf(cartViews + 'OrderDetailView.ets'), /name: PAGE_PATH.CUSTOMER_SERVICE_PAGE, param: \{ orderId: this.order.id, orderName: /)
})

test('商家客服默认待回复，切换全部重置分页，回复沿用买家会话', async () => {
  assert.match(sourceOf(mineViews + 'MineView.ets'), /MerchantServiceView/, '商家区必须有客服留言入口')
  const calls = []
  const Page = pageMethods(mineViews + 'MerchantServiceView.ets', 'MerchantServiceView', {}, {
    RequestAxios: { getForSession: async (...args) => { calls.push(args); return { items: [], pages: 1 } } }
  })
  const page = new Page(); page.active = true; page.user = { token: 'm', role: 'merchant' }
  await page.load(1); assert.match(calls[0][0], /state=pending/)
  page.page = 4; await page.changeFilter('all'); assert.match(calls[1][0], /state=all/); assert.equal(page.page, 1)
  const routes = []; page.stackPath = { pushPath: path => routes.push(path) }
  page.open({ buyerId: 'buyer' }); assert.equal(routes[0].param.buyerId, 'buyer')
})

test('开票和评价审计显示白话动作，不把邮箱税号放进摘要', () => {
  const audit = execute(sourceOf('mixed-development-h5/features/mine/src/main/ets/presentation/utils/AuditPresentation.ets'))
  assert.equal(audit.auditActionLabel('invoice.request'), '登记开票信息')
  assert.equal(audit.auditActionLabel('invoice.issued'), '标记已开票')
  assert.equal(audit.auditActionLabel('review.hide'), '隐藏评价')
  assert.equal(audit.auditActionLabel('review.republish'), '修改后重新发布评价')
  assert.equal(audit.auditActionLabel('avatar.reset'), '重置违规头像')
})

test('评价敏感词拦截展示原提示，保留输入供修改', async () => {
  const fixture = evaluationFixture(), page = fixture.newPage()
  page.aboutToAppear(); await tick(); page.content = '触发服务端过滤内容'; page.score = 3
  fixture.setSubmit(async () => { throw new BusinessError('内容包含不适合发布的词，请修改后再发布', 400) })
  await page.submitEvaluation()
  assert.equal(page.errorText, '内容包含不适合发布的词，请修改后再发布')
  assert.equal(page.content, '触发服务端过滤内容'); assert.equal(page.submitted, false)
})

test('客服上传照片用原会话，响应丢失只重试原编号，私有照片走鉴权下载', async () => {
  const uploads = [], messages = [], reads = []
  let fail = true
  const Page = pageMethods(mineViews + 'CustomerServiceView.ets', 'CustomerServiceView', {}, {
    util: { generateRandomUUID: () => 'message-key', Base64Helper: class { decodeSync() { return new Uint8Array([255, 216, 255]) } encodeToStringSync() { return 'jpeg' } } },
    checkoutFailure: () => ({ status: 0 }),
    RequestAxios: {
      postMultipartForSession: async (...args) => { uploads.push(args); if (fail) throw new Error('lost'); return { path: '/uploads/image.jpg' } },
      postWithSession: async (...args) => { messages.push(args); return { id: 1 } },
      getImageForSession: async (...args) => { reads.push(args); return new Uint8Array([255]).buffer }
    }
  })
  const page = new Page(); page.active = true; page.user = { token: 't', id: 'buyer', role: 'buyer' }; page.load = async () => {}
  page.photos = [{ bytes: 'jpeg', requestKey: 'photo-key' }]; page.content = '照片里的问题'
  await page.send(); assert.equal(messages.length, 0); assert.equal(page.pending, true)
  fail = false; await page.send(); assert.equal(uploads.length, 2)
  assert.equal(uploads[0][2], uploads[1][2]); assert.equal(uploads[1][3], 't')
  assert.equal(messages[0][1].images[0], '/uploads/image.jpg')
  assert.equal(await page.loadPhoto('/uploads/image.jpg'), 'data:image/jpeg;base64,jpeg'); assert.equal(reads[0][1], 't')
})

test('客服系统选图临时遮挡后保留照片，销毁页面或换账号丢弃迟到照片', async () => {
  for (const transition of ['picker', 'destroy', 'account']) {
    const selected = deferred()
    const Page = pageMethods(mineViews + 'CustomerServiceView.ets', 'CustomerServiceView', {}, {
      pickProductImage: () => selected.promise,
      util: { generateRandomUUID: () => 'selected-photo' }
    })
    const page = new Page(); page.active = true; page.user = { token: 't', id: 'buyer', role: 'buyer' }
    page.load = async () => {}
    const selecting = page.choosePhoto()
    assert.equal(typeof page.hidden, 'function', '系统选图的遮挡应与页面销毁分开处理')
    page.hidden()
    if (transition === 'destroy') page.aboutToDisappear()
    if (transition === 'account') { page.user = { token: 'new', id: 'other', role: 'buyer' }; page.accountChanged() }
    selected.resolve('selected-jpeg'); await selecting
    assert.equal(page.photos.length, transition === 'picker' ? 1 : 0)
    assert.equal(page.choosing, false)
  }
})

test('B包开票和留言评价入口的按钮不依赖系统蓝色', () => {
  for (const view of ['MineView', 'MerchantOrderView', 'ProductManageView']) {
    for (const button of sourceOf(mineViews + view + '.ets').split(/\bButton\(/).slice(1)) {
      const style = button.split('.onClick(')[0]
      assert.ok(style.includes('.backgroundColor(') && style.includes('.fontColor('), view + ': ' + button.slice(0, 70))
    }
  }
})

test('商家开票成功不显示读取重试，下单时间按北京时间展示', () => {
  const source = sourceOf(mineViews + 'MerchantOrderView.ets')
  assert.ok(source.includes('this.message && !this.order'), '只有读取订单失败时展示读取重试')
  assert.ok(source.includes('formatBeijingTime(this.order.createTime)'), '商家订单时间不能直接显示UTC原始串')
})

test('复核补改：成功提示不用警示色，关联订单显示商品和下单时间，列表卡片随状态刷新，开票输入有标签', () => {
  const r = { $r: name => name }
  for (const [dir, view] of [[mineViews, 'MerchantOrderView'], [mineViews, 'CustomerServiceView'], [mineViews, 'ReviewManageView']]) {
    const Page = pageMethods(dir + view + '.ets', view, {}, r)
    const page = new Page()
    assert.equal(typeof page.messageColor, 'function', view + ' 缺少按结果区分的提示颜色')
    page.messageOk = true; assert.equal(page.messageColor(), '[ui_components].color.text', view)
    page.messageOk = false; assert.equal(page.messageColor(), '[ui_components].color.red', view)
    assert.ok(!sourceOf(dir + view + '.ets').includes("Text(this.message).fontColor($r('[ui_components].color.red'))"), view + ' 成功提示仍固定为警示色')
  }
  const order = sourceOf(cartViews + 'OrderDetailView.ets')
  assert.ok(!order.includes("Text(this.invoiceMessage).fontColor($r('[ui_components].color.red'))"), '开票登记成功提示仍固定为警示色')
  assert.ok(order.includes('orderName:') && order.includes('orderCreatedAt:'), '从订单进入客服要带上商品名和下单时间')

  const Service = pageMethods(mineViews + 'CustomerServiceView.ets', 'CustomerServiceView', {}, { ...r, formatBeijingTime: () => '2026-11-11 23:33' })
  const service = new Service()
  assert.equal(service.orderLabel('设备独立测试商品', 1), '关联订单：设备独立测试商品 · 2026-11-11 23:33 下单')
  const serviceSource = sourceOf(mineViews + 'CustomerServiceView.ets')
  assert.ok(!serviceSource.includes("'关联订单：' + this.orderId") && !serviceSource.includes("'关联订单：' + item.orderId"), '关联订单不能直接显示订单编号')
  const routes = []; service.stackPath = { pushPath: route => routes.push(route) }
  service.user = { role: 'merchant' }; service.openOrder('order-1')
  assert.equal(routes[0].name, 'MerchantOrderView'); assert.equal(routes[0].param, 'order-1')

  const review = sourceOf(mineViews + 'ReviewManageView.ets')
  assert.ok(review.includes("(item: MerchantReview) => item.id + ':' + (item.hiddenReason || ''))"), '隐藏原因变化后评价卡片要刷新')
  assert.ok(review.includes('if (!item.hiddenReason) {'), '已隐藏的评价不再显示隐藏按钮')
  assert.ok(sourceOf(mineViews + 'MerchantServiceView.ets').includes("(item: ServiceThread) => item.buyerId + ':' + item.updatedAt + ':' + item.awaitingReply)"), '回复后留言会话卡片要刷新')

  const form = sourceOf('mixed-development-h5/features/cart/src/main/ets/presentation/components/InvoiceForm.ets')
  for (const label of ["Text('发票抬头')", "Text('单位税号')", "Text('接收邮箱')"]) assert.ok(form.includes(label), '开票表单缺少标签 ' + label)
})
