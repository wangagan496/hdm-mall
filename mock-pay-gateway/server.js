const os = require('os')
const path = require('path')
const express = require('express')
const cors = require('cors')

try {
  require('dotenv').config({ path: path.join(__dirname, '.env') })
} catch {
}

const PORT = Number(process.env.PORT || 3001)
const APP_ID = (process.env.ALIPAY_APP_ID || '').trim()
const PRIVATE_KEY_RAW = (process.env.ALIPAY_PRIVATE_KEY || '').trim()
const ALIPAY_PUBLIC_KEY_RAW = (process.env.ALIPAY_PUBLIC_KEY || '').trim()
const GATEWAY = (process.env.ALIPAY_GATEWAY || 'https://openapi-sandbox.dl.alipaydev.com/gateway.do').trim()

function chunk64(body) {
  return body.replace(/\s+/g, '').replace(/(.{64})/g, '$1\n').trim()
}

// .env 里私钥/公钥支持两种写法：纯 base64 正文，或带 -----BEGIN----- 头（\n 转义也行）
function toPem(raw, isPrivate) {
  if (!raw) {
    return ''
  }
  const unescaped = raw.replace(/\\n/g, '\n').trim()
  if (unescaped.includes('-----BEGIN')) {
    return unescaped
  }
  const body = chunk64(unescaped)
  return isPrivate
    ? `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`
    : `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----`
}

const PRIVATE_KEY = toPem(PRIVATE_KEY_RAW, true)
const ALIPAY_PUBLIC_KEY = toPem(ALIPAY_PUBLIC_KEY_RAW, false)
const alipayConfigured = !!(APP_ID && PRIVATE_KEY && ALIPAY_PUBLIC_KEY)

let alipaySdk = null
if (alipayConfigured) {
  const AlipaySdk = require('alipay-sdk').default || require('alipay-sdk')
  alipaySdk = new AlipaySdk({
    appId: APP_ID,
    privateKey: PRIVATE_KEY,
    alipayPublicKey: ALIPAY_PUBLIC_KEY,
    signType: 'RSA2',
    gateway: GATEWAY
  })
}

function lanAddress() {
  if (process.env.ALIPAY_RETURN_URL) {
    return process.env.ALIPAY_RETURN_URL.replace(/\/pay\/return\/?$/, '')
  }
  const nets = os.networkInterfaces()
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) {
        return `http://${net.address}:${PORT}`
      }
    }
  }
  return `http://127.0.0.1:${PORT}`
}

const BASE = lanAddress()
const RETURN_URL = `${BASE}/pay/return`
const NOTIFY_URL = `${BASE}/api/pay/notify`

const app = express()
app.use(cors())
app.use(express.urlencoded({ extended: true }))
app.use(express.json())

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    alipayConfigured,
    gateway: GATEWAY,
    returnUrl: RETURN_URL,
    notifyUrl: NOTIFY_URL,
    hint: alipayConfigured ? '支付宝沙箱可用' : '未配置密钥，将返回模拟收银台'
  })
})

const MOCK_PAGE = (orderId, amount) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>支付宝 - 确认付款</title></head>
<body style="margin:0;font-family:sans-serif;background:#f5f6f7">
  <div style="max-width:420px;margin:0 auto;padding:24px 16px">
    <div style="background:#1677FF;border-radius:0 0 12px 12px;color:#fff;padding:28px 20px">
      <div style="font-size:13px;opacity:.85">付款给 HDM商城</div>
      <div style="font-size:34px;font-weight:600;margin-top:8px">¥ ${amount}</div>
    </div>
    <div style="background:#fff;margin-top:12px;border-radius:12px;padding:16px">
      <div style="display:flex;justify-content:space-between;font-size:14px;color:#333">
        <span>订单号</span><span style="color:#999">${orderId}</span>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:14px;color:#333;margin-top:10px">
        <span>收款方</span><span>鸿蒙智选商城</span>
      </div>
    </div>
    <a href="${RETURN_URL}?orderId=${encodeURIComponent(orderId)}&payResult=true"
       style="display:block;margin-top:20px;background:#1677FF;color:#fff;text-align:center;
              border-radius:24px;padding:14px 0;font-size:16px;text-decoration:none">立即付款</a>
    <p style="font-size:11px;color:#999;text-align:center;margin-top:14px">沙箱模拟收银台 · 不产生真实扣款</p>
  </div>
</body></html>`

app.get('/pay/wap/aliPay', async (req, res) => {
  const orderId = String(req.query.orderId || '').trim()
  const amount = Number(req.query.amount || 0).toFixed(2) || '0.01'
  if (!orderId) {
    return res.status(400).json({ error: '缺少 orderId' })
  }
  if (!alipayConfigured) {
    return res.type('html').send(MOCK_PAGE(orderId, amount))
  }
  try {
    const form = await alipaySdk.pageExec('alipay.trade.wap.pay', {
      method: 'GET',
      returnUrl: `${RETURN_URL}?orderId=${encodeURIComponent(orderId)}`,
      notifyUrl: NOTIFY_URL,
      bizContent: {
        out_trade_no: orderId,
        total_amount: amount,
        subject: 'HDM商城订单-' + orderId,
        product_code: 'QUICK_WAP_PAY'
      }
    })
    if (typeof form === 'string' && form.startsWith('http')) {
      return res.redirect(form)
    }
    return res.type('html').send(form)
  } catch (error) {
    return res.status(500).json({
      error: '支付宝沙箱下单失败',
      detail: error && error.message ? error.message : String(error)
    })
  }
})

app.get('/pay/return', (req, res) => {
  const orderId = req.query.orderId || req.query.out_trade_no || ''
  const tradeStatus = String(req.query.trade_status || '')
  const ok = tradeStatus === 'TRADE_SUCCESS' || tradeStatus === 'TRADE_FINISHED' || req.query.payResult === 'true'
  res.type('html').send(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>支付结果</title></head>
<body style="margin:0;font-family:sans-serif;background:#f5f6f7;height:100vh;display:flex;
     align-items:center;justify-content:center">
  <div style="text-align:center">
    <div style="width:64px;height:64px;margin:0 auto;border-radius:50%;
         background:${ok ? '#07C160' : '#B0171F'};color:#fff;font-size:34px;line-height:64px">
      ${ok ? '✓' : '!'}
    </div>
    <div style="margin-top:16px;font-size:18px;font-weight:600">${ok ? '支付成功' : '支付未完成'}</div>
    <div style="margin-top:8px;font-size:13px;color:#999">订单 ${orderId} · 请返回App查看结果</div>
  </div>
</body></html>`)
})

app.post('/api/pay/notify', (req, res) => {
  if (!alipayConfigured) {
    return res.send('success')
  }
  try {
    const signVerified = alipaySdk.checkNotifySign(req.body)
    const tradeStatus = String(req.body.trade_status || '')
    if (signVerified && (tradeStatus === 'TRADE_SUCCESS' || tradeStatus === 'TRADE_FINISHED')) {
      console.log(`[notify] 订单 ${req.body.out_trade_no} 支付成功，金额 ${req.body.total_amount}`)
      return res.send('success')
    }
    return res.send('fail')
  } catch (error) {
    console.error('[notify] 验签失败:', error && error.message ? error.message : error)
    return res.send('fail')
  }
})

app.get('/api/pay/query', async (req, res) => {
  const orderId = String(req.query.orderId || '').trim()
  if (!orderId) {
    return res.status(400).json({ error: '缺少 orderId' })
  }
  if (!alipayConfigured) {
    return res.json({ alipayConfigured: false, tradeStatus: 'MOCK_SUCCESS' })
  }
  try {
    const result = await alipaySdk.exec('alipay.trade.query', {
      bizContent: { out_trade_no: orderId }
    })
    return res.json(result)
  } catch (error) {
    return res.status(500).json({
      error: '查询失败',
      detail: error && error.message ? error.message : String(error)
    })
  }
})

app.listen(PORT, () => {
  console.log(`[pay-gateway] listening ${BASE}`)
  console.log(`[pay-gateway] alipayConfigured: ${alipayConfigured}`)
  if (!alipayConfigured) {
    console.log('[pay-gateway] 未检测到 .env 密钥，/pay/wap/aliPay 将返回模拟收银台（不报404）')
  }
})
