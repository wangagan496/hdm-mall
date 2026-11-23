# 阶段 2 U2 后端同主版本升级

在 `mall-crazy-design-20261116` 的 `831634b` 工作区验证，使用 Node.js 24.22.3 和 npm 11.19.1。

## 版本与兼容范围

2026-11-18 23:27（北京时间）通过 npm 官方注册表核对 `latest` 标签和当前主版本线中的正式版，排除了预发布版本。Fastify 6 当时在 `next` 标签，multipart 10.1.9 晚于技术报告记录的 10.1.8。

| 依赖 | 声明（前 → 后） | 锁定（前 → 后） | 查询来源 |
| --- | --- | --- | --- |
| Fastify | `^5.6.2` → `^5.12.8` | 5.12.7 → 5.12.8 | [npm](https://registry.npmjs.org/fastify) |
| @fastify/multipart | `^10.1.6` → `^10.1.9` | 10.1.6 → 10.1.9 | [npm](https://registry.npmjs.org/@fastify%2fmultipart) |
| @fastify/rate-limit | `^11.2.1` → `^11.2.2` | 11.2.1 → 11.2.2 | [npm](https://registry.npmjs.org/@fastify%2frate-limit) |
| Zod | `^4.1.12` | 4.6.7，已是最新正式版 | [npm](https://registry.npmjs.org/zod) |

两个插件在所选正式版的入口均声明 `fastify: '5.x'`，rate-limit 文档也将插件 `>=10.x` 对应至 Fastify `^5.x`。安装后复核了两个入口的声明和四个包的实际版本。[multipart 入口](https://github.com/fastify/fastify-multipart/blob/3df4ba29ad082c1b7ed9c6cc7f904262eb2228e9/index.js#L695) · [rate-limit 入口](https://github.com/fastify/fastify-rate-limit/blob/cc8b48188d31a91818616f642381f175243f9865/index.js#L380) · [rate-limit 兼容表](https://github.com/fastify/fastify-rate-limit/blob/cc8b48188d31a91818616f642381f175243f9865/README.md#L19)

Fastify 5.12.8 将 `find-my-way` 的最低版本提高至 9.10.0，改前锁定版本已满足要求。结构化比较确认，移除三个目标声明及条目后，锁文件与基线完全一致。

## 验证结果

| server 内执行的命令 | 结果 |
| --- | --- |
| `npm run check` | 通过，退出码 0 |
| `npm test` | 432 项全部通过，失败、取消、跳过及待办均为 0 |
| `node --test --test-randomize --test-random-seed=271113 test/*.test.ts` | 432 项全部通过，失败、取消、跳过及待办均为 0，输出确认 seed 为 271113 |

以下现有用例在两轮均通过，完整用例名与计数见[日志节选](verification.txt)。

| U2 检查项 | 对应用例与断言 |
| --- | --- |
| 上传限额 | `product-images.test.ts` 的「商品图片按账号与请求号登记，只接受JPEG且大小受限，头像文件大小限制仍生效」，商品图和头像超过 512 KiB 时返回 413。 `after-sales.test.ts` 的 AS-08 用例核对售后照片上限为 3 张。 |
| 限流 | `production-config.test.ts` 的「可信代理下不同真实来源独立限流，伪造链左端不能绕过限制」和「未配置代理或直连不可信来源时，伪造转发头不能更换限流身份」，触发限额时返回 429。 |
| 鉴权 | `identity-runtime.test.ts` 的「多身份切换保留令牌、只授予已有身份、旧请求无写入且审计保留当时身份」和 `trade.test.ts` 的「购买人无发货权限，提醒不改变状态，注销撤销会话」。 |
| 幂等 | `checkout.test.ts` 的 B-31/B-32/B-34 检查请求号只读恢复、本人隔离、幂等与过期状态。 |
| 事务 | `order-cancellation.test.ts` 的 B-82 注入库存、退款、通知与回执写入失败，核对整单回滚及同号重试。 |
| 退款与物流 | `sandbox-flow.test.ts` 的 G 用例核对迟到支付成功自动原路退款、重复通知不重复退款、订单电话快照核验及轨迹去重。 `logistics.test.ts` 的 D18 用例核对发货时校验承运商和运单，以及发货、签收、确认收货各自记时。 |
| 恢复 | `backup.test.ts` 的在线 WAL 快照与头像恢复用例、`reconciliation-backup.test.ts` 的 D18 渠道账单与物流恢复用例，以及 `order-cancellation.test.ts` 的 B-78 B-82 进程重启查原回执用例。 |

## 验证边界

测试使用既有夹具、临时数据和本地传输替身。未启动业务服务，未读取或修改 `server/.env`，未调用真实支付、物流或模型渠道。上传证据覆盖超限拒绝，本次没有专门执行客户端中断上传后检查残留流或文件的用例。

初次 npm 查询因默认缓存目录无写权限而失败，改用临时缓存后通过。临时缓存和验证脚本已在本轮结束前清理。
