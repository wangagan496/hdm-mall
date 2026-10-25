# 自营交易后端

TypeScript + Node.js 24 + Fastify + SQLite。用于当前鸿蒙商城第一版：下单、本人/亲友模拟支付、商家发货、本人/亲友代收、购买人评价。支付不产生真实扣款，不代表已经接入商用支付。

## 启动

在 `server` 目录执行 `npm ci --registry=https://registry.npmjs.org` 安装锁定依赖，然后在仓库根目录执行：

```powershell
pwsh -File scripts/start-trade-server.ps1
```

没有 `.env` 时，启动脚本使用 `.env.example` 的本地开发配置，启用模拟支付。服务地址为 `http://127.0.0.1:3000`。数据库与上传头像保存在忽略提交的 `server/data` 中，重启不会清空。首次初始化 4 个商品、8 个规格；不初始化公共测试密码或商家账号。

应用的登录页面可注册买家账号。账号为 3～32 位字母、数字、下划线，密码 8～128 位。新后端不沿用旧演示接口的账号和订单；已有安装请退出旧账号后重新注册登录。

商家：复制 `.env.example` 为本地 `.env`，设置 `MERCHANT_ACCOUNT` 与至少 12 位的 `MERCHANT_PASSWORD`，重启服务。该配置只创建首次商家账号，不覆盖已有账号，不允许把已有买家提升为商家。商家登录同一应用后，在「我的 → 亲友中心 / 商家发货」处理订单。

模拟器通过 `hdc rport tcp:3000 tcp:3000` 访问电脑服务。仓库脚本可在构建后完成映射、安装与启动：

```powershell
pwsh -File scripts/device-trade.ps1 -Action install
```

真机局域网：把服务 `HOST` 改为 `0.0.0.0`，`PUBLIC_URL` 和原生 `GlobalVariable.BASE_URL` 改为电脑可达的局域网地址。H5 通过原生桥读取同一服务地址。部署时使用 HTTPS，模拟支付只用于测试环境；`NODE_ENV=production` 与 `MOCK_PAYMENTS=true` 同时设置会拒绝启动。

`CORS_ORIGINS` 是所有环境（包括 production）的显式来源白名单，使用逗号分隔；打包后的 ArkWeb 从 rawfile 加载 H5 时发送 `Origin: null`，需要支持时必须显式加入 `null`，未加入即返回 403。未设置该变量的内置默认值只包含本地 H5 开发来源，不包含 `null`；`.env.example` 为内嵌 H5 演示显式配置了 `null`。生产环境允许 `null` 时启动日志会警告：该来源也包括其他不透明来源，并不专属于 ArkWeb。接口仍使用 Bearer token 鉴权、不使用 cookie，CORS 放行不代替接口鉴权。

## 亲友规则

绑定有方向：A 添加 B，B 确认后，B 成为 A 的代付和代收亲友；不会自动反向授权。邀请页明确说明两种权限。任意一方可以解除绑定。

1. A 创建待付款订单，在支付页邀请一个已确认绑定的亲友 B 代付。
2. B 在自己的亲友中心看到待代付订单，核对金额并确认模拟付款。付款前解除绑定会使代付失败。A 可在未付款时切回本人付款。
3. 商家发货后，A 及 A 当前所有已确认绑定的亲友都能确认收货，无需每单指定代收人；实际付款人无需与代收人为同一人。
4. 必须是实际由亲友支付的订单才开放代收资格。本人支付的订单，即使存在绑定关系，也只能本人收货。
5. 收货时重新检查绑定关系，解绑立即失去代收权限。多人同时确认只有一次成功，数据库记录实际确认人和时间。
6. 只有 A 能取消自己的未付款订单及提交评价。亲友看不到收货地址、联系方式，不获得修改地址、发货或评价权限。

## 交易规则

- 金额按后端规格价格计算，以整数分存储；客户端不能指定成交价。
- 创建订单使用 `requestKey` 幂等：同一用户、同一请求号、相同参数只创建一笔订单；同号不同参数拒绝。
- 下单和占用库存处于同一数据库事务。规格库存耗尽标为售罄，全部规格耗尽后从商品列表隐藏；已打开页面提交时仍校验库存。
- 未付款 15 分钟过期，释放库存。定时任务和查询触发过期检查，重复取消不会重复释放。
- 保存商品、价格和地址快照。付款人、收货确认人使用独立字段，订单归属不变。
- 订单状态：1 待付款、2 待发货、3 待收货、4 待评价、5 已评价、6 已取消。
- 提醒发货不会推进订单；只有商家接口可以发货。

## 接口入口

返回格式沿用原工程 `{ code: "1", result: ... }`。失败返回对应 HTTP 状态和 `{ code: "0", msg, requestId }`。登录后通过 `Authorization: Bearer <token>` 访问；会话有效期 24 小时，退出接口撤销当前会话。

| 方法与路径 | 用途 |
| --- | --- |
| POST `/register`、`/login`、`/logout` | 账号与会话 |
| GET/PUT `/member/profile` | H5 资料 |
| POST `/member/profile/avatar` | JPEG 头像上传，上限 512 KiB |
| GET `/goods?id=...`、POST `/search/all` | 商品与搜索 |
| `/member/cart`、`/member/address` | 购物车与地址 |
| GET/POST `/member/relations` | 绑定列表、邀请 |
| PUT `/member/relations/:id` | `{ action: "accept" / "revoke" }` |
| POST `/member/order` | `{ requestKey, addressId, goods: [{ skuId, count }] }` |
| GET `/member/order`、`/member/order/:id` | 自己的订单与有权限查看的详情 |
| PUT `/member/order/:id/payer` | `{ friendId }`；传 null 切回本人付款 |
| POST `/member/order/:id/mock-pay` | `{ amountCents }`，服务端校验实际付款身份 |
| GET `/member/family-orders` | 可代付、可代收以及本人参与记录 |
| GET `/merchant/orders` | 商家待发货列表 |
| POST `/merchant/orders/:id/ship` | 商家发货 |
| PUT `/member/order/:id/receipt` | 本人或具备资格的亲友确认收货 |
| PUT `/member/order/:id/evaluation` | `{ score: 1..5, content }`，5～500 字 |

## 验证

```powershell
pwsh -File scripts/verify-trade.ps1
pwsh -File scripts/verify-trade.ps1 -NativeOnly
```

第一条执行后端类型检查、HTTP 集成测试、H5 lint/类型检查/构建并同步 rawfile。第二条使用本机 DevEco 环境构建签名 `.app`。设备安装、桥接与实际页面操作需要另外验证。

测试使用独立数据库和测试账号，覆盖本人五步交易、所有绑定亲友代收、未绑定拒绝、解绑即时生效、代付授权、并发最后一件、重复订单、事务回滚、超时释放、账号隔离、商家权限、退出撤销、数据重启恢复与真实 HTTP 监听。测试不会修改开发数据库。

第一版不包含真实支付渠道、物流查询、退款售后、亲情卡额度扣款及运营后台。商品图目前为本地占位图，商品通过初始化脚本提供。SQLite 采用单服务事务管理，适合当前学习和本地验证规模。
