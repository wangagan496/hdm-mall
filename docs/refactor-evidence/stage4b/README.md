# 阶段 4B 降价雷达与消费者一键确认补差

任务 `hdm-stage4b-20261124-01`，基线分支 `mall-crazy-design-20261116`（基线 `4467aa9`，已包含阶段 4A）。

## 实现与边界

- **迁移 029**（[029-price-events-radar.sql](../../../server/src/migrations/029-price-events-radar.sql)）：新增 `price_events`（正整数分且仅允许降价）、`compensation_drafts`（含 `pending` / `pending_budget` / `confirmed` / `expired` / `cancelled` 与唯一幂等键 `idempotency_key`）、`compensation_receipts`（唯一 `draft_id` 与唯一 `(buyer_id, request_key)`），并将 `PRAGMA user_version` 升至 `29`。旧迁移 `023–028` 与 U3–U7 模块均未修改；未引入 Layer C 自动划扣、SSE 或 React 代码。
- **降价观察与捕获**（[price-events.ts](../../../server/src/price-events.ts)、[products.ts](../../../server/src/products.ts)、[promotions.ts](../../../server/src/promotions.ts)）：仅当启用的 SKU 降价（`merchant_edit`）或店铺公开满减开启/加惠降低了订单门槛后实付净额（`promotion_add` / `promotion_change` / `promotion_remove`）时写入 `price_events`；涨价与非法负值/非整数分直接忽略。
- **降价雷达与分摊计算**（[price-radar.ts](../../../server/src/price-radar.ts)）：每 5 分钟后台执行 `scheduledRadarTick(db, now)`（在 [app.ts](../../../server/src/app.ts) 绑定定时器并在 `onClose` 清理），扫描有效已付款订单（`effective_at <= paid_at < effective_at + window_days * 86400_000`），按 `SHA-256(orderId:policyId:priceEventId)` 幂等生成有效期 48 小时的 `compensation_drafts`。按原篮各行实际支付占比与当前完整现行公开满减重算整篮新低并逐行分摊；遇到部分/全部退货时按留件比例核减对应行分摊，**严禁把已退件份额转摊给留件**；再以 `min(basket_delta_cents, budget_per_order_cents)` 封顶。当活动剩余总预算不足以覆盖本单封顶额时，草稿标为 `pending_budget` 而不展示为可确认，待后续预算释放后由雷达自动激活为 `pending`。
- **一键确认与硬不变量**（[compensation.ts](../../../server/src/compensation.ts)、[app.ts](../../../server/src/app.ts)、[orders.ts](../../../server/src/orders.ts)、[audit.ts](../../../server/src/audit.ts)）：
  - `/buyer/` 路由前缀统一由全局 `requireBuyer` 保护，提供 `GET /buyer/orders/:id/compensation/drafts`、`GET /buyer/compensation/drafts/:draftId`、`POST /buyer/compensation/confirm` 与 `GET /buyer/compensation/receipts/:id`。
  - `POST /buyer/compensation/confirm` 强制校验买家本人、草稿未过期（过期置 `expired` 并返回 `403`）、前端确认金额严格等于 `capped_cents`（不符返回 `400`）、同单硬不变量 **`R + C + U + capped_cents <= F`**（已退款 `R` + 已登记有效补差 `C + U` + 本次确认不超过实付 `F`，超限返回 `409`）、活动总预算上限（超限返回 `409`）及 `(buyer_id, requestKey)` 幂等性（同号同参返回原回执，同号异参返回 `409`）。
  - 确认后写入 `channel_status = 'pending'` 补差回执与 `compensation.confirm` 审计日志，返回状态文案 **`补差已登记，渠道处理中`**；若渠道后续处于 `unknown`，返回 **`待执行（渠道结果待核实）`**，绝不冒充已到账。
- **备份与校验兼容**（[backup.ts](../../../server/src/backup.ts)、[audit-backup.ts](../../../server/src/audit-backup.ts)）：`manifestSchema` 与 `inspectDatabase` 支持到版本 29，统计 `price_events` / `compensation_drafts` / `compensation_receipts`，校验草稿与回执归属、`R + C + U <= F` 以及 `compensation.confirm` 审计记录归属；篡改回执金额触发校验失败。
- **契约与鸿蒙原生端**（[compensation.ts](../../../contract-kit/v1/compensation.ts)、[vectors/compensation.ts](../../../contract-kit/v1/vectors/compensation.ts)、[generate.ts](../../../contract-kit/v1/generators/generate.ts)、[CompensationModels.ets](../../../mixed-development-h5/commons/models/src/main/ets/CompensationModels.ets)、[BusinessModels.ets](../../../mixed-development-h5/commons/models/src/main/ets/BusinessModels.ets)、[CompensationPresentation.ets](../../../mixed-development-h5/features/cart/src/main/ets/presentation/utils/CompensationPresentation.ets)、[OrderDetailView.ets](../../../mixed-development-h5/features/cart/src/main/ets/presentation/views/OrderDetailView.ets)）：自动生成双端 Schema 与向量测试；`OrderDetailView` 在 `canApplyAfterSale` 区块之后展示待确认 `降价补差` 草稿卡片、草稿详情与回执双向 `$$this.*` `bindSheet`、一键确认按钮、`查看回执` 入口及 `403/400/409` 中文提示，所有控件使用主题资源色并保留异步页面代际与切号隔离校验。

## 验证结果

| 检查项 | 实测结果 |
| --- | --- |
| 契约检查 | `node contract-kit/v1/generators/generate.ts --check` 通过（exit 0）。 |
| 服务端类型检查 | `server` 内 `npx tsc --noEmit`（`npm run check`）通过（exit 0）。 |
| 服务端全量测试 | `server` 内 `npm test` 共 **530/530** 通过（含新增 [compensation.test.ts](../../../server/test/compensation.test.ts) 8 项，零跳过）。 |
| 客户端隔离全量测试 | `node --test scripts/tests/*.test.mjs` 共 **666/666** 通过（含新增 [compensation-native.test.mjs](../../../scripts/tests/compensation-native.test.mjs) 2 项，零跳过）。 |
| Hvigor 模块测试 | 12 个模块合计 **184/184** 通过（`models` 90、`cart` 45、`home` 27、`mine` 11、`category` 6、`network` 5，其余 6 个模块均为 0；失败、错误、忽略均为 0）。 |
| 签名构建包 | 通过 `pwsh -File scripts/verify-optimization-build.ps1 -SkipH5` 构建：`mixed-development-h5-default-all-signed.app` 大小 `10,715,518` 字节，SHA256 `55DD0E4298EF12CA5E307AF9F9DD48140F8BD332C1103F65D9EF9DF57E14D345`，SHA1 `6AB32CBE3E59BB1B7F7AB860035E01A1C3ED9D9C`，包内 H5 校验匹配。完整日志归档于 [hdm-optimization-build.log](hdm-optimization-build.log)。 |

## 真机验收与清理（Pura 90 API24）

在既有 `Pura 90 API24`（`127.0.0.1:5555`，API 24）与隔离测试夹具 `127.0.0.1:3103`（临时 `rport tcp:3000 -> tcp:3103`）完成浅色与深色两轮端到端真机走查（未向 `PhoneAbility` 传入任何测试启动参数）：

1. **商家 UI 降价触发观测**（[light/01-merchant-price-drop.jpg](device/light/01-merchant-price-drop.jpg) / [dark/01-merchant-price-drop.jpg](device/dark/01-merchant-price-drop.jpg)）：商家端 `ProductManageView` → `ProductEditView` 将 `¥23.71` 下调为 `¥13.71` 并点击保存后提示“商品已保存”；推进 5 分钟雷达周期，自动签发 `1000` 分待确认草稿。
2. **买家订单详情展示待确认补差草稿**（[light/02-buyer-order-draft.jpg](device/light/02-buyer-order-draft.jpg) / [dark/02-buyer-order-draft.jpg](device/dark/02-buyer-order-draft.jpg)）：买家端订单详情页展示 `价格保护` 与 `降价补差` 草稿卡片（`¥10.00`、第 1 版价保、有效期、`查看详情` 与 `一键确认` 按钮）。
3. **买家一键确认返回非到账处理中回执**（[light/03-buyer-confirm-receipt.jpg](device/light/03-buyer-confirm-receipt.jpg) / [dark/03-buyer-confirm-receipt.jpg](device/dark/03-buyer-confirm-receipt.jpg)）：点击 `一键确认` 后展示 `补差已登记，渠道处理中`（浅色回执 `60384196-67b2-496f-9c71-36f7a285556d`、深色回执 `110b5e08-cfae-4c5e-92df-c8590a720520`）与 `查看回执` 按钮，绝不冒充到账。
4. **买家查看回执半模态详情**（[light/04-buyer-receipt-detail.jpg](device/light/04-buyer-receipt-detail.jpg) / [dark/04-buyer-receipt-detail.jpg](device/dark/04-buyer-receipt-detail.jpg)）：点击 `查看回执` 弹出 `价保补差回执` 半模态弹层，完整展示补差金额、处理状态、政策版本、回执编号、确认时间与关闭按钮；两轮深浅主题下均已逐图核验无遮挡、无溢出。

- **结构化结果与截图清单**：[screenshots.json](device/screenshots.json)、[light/result.json](device/light/result.json)、[dark/result.json](device/dark/result.json)。
- **现场还原与清理**：已还原原深色主题（`dark -> dark`）、恢复并清空 `fport`（`[Empty]`）、释放 `3103` 端口（`listener3103: false`）、确认相册数量未增（`1 -> 1`），并清理临时脚本、设备临时截图与夹具临时上传目录。见 [light/cleanup.json](device/light/cleanup.json) 与 [dark/cleanup.json](device/dark/cleanup.json)。
