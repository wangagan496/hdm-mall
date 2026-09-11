# HDM商城 - 支付宝沙箱网关（mock-pay-gateway）

## 这是什么
给 `mixed-development-h5 / PayView` 用的本地 Node 网关，让 **WebView 真能调起支付宝沙箱**，同时**自动降级**：真机没装支付宝/网关没启动时，App 内原生 `确认支付` 仍可完成 `demoOrderStore.setOverlay(orderId, 2)` 的虚拟支付闭环，简历可写“聚合收银台双通道降级”。

## 为什么必须 Node
支付宝 `RSA2 签名` 的 `商户私钥` 不能打包进前端 `PayView.ets`，必须由 Node 持有，后端调用 `alipay.trade.wap.pay` 生成跳转 URL / Form，WebView 再提交。

## 快速开始

### 1. 配置沙箱
1. 登录 https://open.alipay.com/develop/sandbox/app
2. 记录 `AppID`，在“接口加签方式”下载支付宝官方密钥工具生成 `应用私钥/支付宝公钥`
3. `mock-pay-gateway/.env.example` 复制为 `.env`，填入 `ALIPAY_APP_ID / ALIPAY_PRIVATE_KEY / ALIPAY_PUBLIC_KEY`

> 不填也能跑：网关会以 Mock HTML 响应 `/pay/wap/aliPay`，PayView 会显示“未检测到网关，将使用模拟支付”，不报 404。

### 2. 启动网关
```bash
cd mock-pay-gateway
npm install
npm run dev    # http://127.0.0.1:3001/health 应返回 { alipayConfigured: true/false }
```

### 3. 让真机连上
`GlobalVariable.PAY_GATEWAY_URL` 默认 `http://127.0.0.1:3001`，模拟器可用，真机需改成你电脑的局域网 IP，例如 `http://192.168.1.8:3001`，并保证手机与电脑同 Wi-Fi。

### 4. 验证
- App：下单 -> 去支付 -> 选支付宝 -> 点 `使用支付宝沙箱支付` -> WebView 打开支付宝沙箱收银台 -> 用沙箱买家账号付款 -> 自动回跳 App -> `支付成功`
- Mock：不点沙箱按钮，直接点 `确认支付 ¥xx.xx` -> 同样 `setOverlay(2)` -> `支付成功`，无 WebView

## 接口
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /health | 供 PayView 探测 `alipayConfigured` |
| GET | /pay/wap/aliPay?orderId=xxx&amount=0.01 | WAP 支付，302 或 Form HTML |
| GET | /pay/return?orderId=xxx&payResult=true | 同步回跳，PayView 拦截解析 |
| POST | /api/pay/notify | 异步通知验签回 `success` |
| GET | /api/pay/query?orderId=xxx | 交易查询 |

## 简历话术
> 自研聚合收银台：抽象 `PayChannelStrategy`，WebView 真网关与本地 Mock 双通道自动降级；支付宝 `RSA2` 签名在 Node 网关完成，前端零密钥；通过 `onLoadIntercept` 拦截 `alipays://` 与 `/pay/return` 闭环，超时订单前置拦截。

## 常见问题
- **WebView 白屏/HTTP 404**：网关未启动，或真机 `PAY_GATEWAY_URL` 仍是 `127.0.0.1`。
- **沙箱提示“商家订单参数异常”**：`ALIPAY_PUBLIC_KEY` 填成了应用公钥，请在沙箱详情页复制“支付宝公钥”。
- **需要线上演示**：把 Node 部署到任意公网机器，改 `ALIPAY_RETURN_URL / ALIPAY_NOTIFY_URL` 为公网地址即可。
