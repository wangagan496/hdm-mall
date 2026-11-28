# 阶段 5 消费保护与待买清单（花钱刹车 / D22）

任务 `hdm-stage5-20261124-01`，基线分支 `mall-crazy-design-20261116`（基线 `28fdbf18ea66d055f35dd8eb9628e669f8dba95a`）。

## 实现与边界

- **迁移 031**（[031-spending-guard.sql](../../../server/src/migrations/031-spending-guard.sql)）：新增仅追加版本表 `spending_rules`、同订单占额唯一表 `spending_reservations`（`reserved` / `settled` / `released`）以及冷静待买清单 `purchase_wishlist`（`waiting` / `cancelled` / `confirmed` / `expired`），并将 `PRAGMA user_version` 升至 `31`。旧迁移 `002–030` 与既定价格保护/审计结构均保持兼容并补充 `v30 -> v31` 自动升级与历史夹具回退适配。
- **契约与校验**（[spending-guard.ts](../../../contract-kit/v1/spending-guard.ts)、[spending-guard.ts vectors](../../../contract-kit/v1/vectors/spending-guard.ts)、[generate.ts](../../../contract-kit/v1/generators/generate.ts)、[generated.ts](../../../server/src/spending-guard/generated.ts)、[SpendingGuardModels.ets](../../../mixed-development-h5/commons/models/src/main/ets/SpendingGuardModels.ets)、[SpendingGuardVectors.test.ets](../../../mixed-development-h5/commons/models/src/test/SpendingGuardVectors.test.ets)）：双端同源生成 6 套结构解析器与 12 组正反契约向量，所有正数金额与时长均绑定整数区间校验。
- **消费保护引擎与账期规则**（[spending-guard.ts](../../../server/src/spending-guard.ts)）：
  - 规则默认停用（`version = 0, enabled = false`）；启用前须明确确认北京时间自然月与跨月退款口径，并至少设置月度预算、单笔限额或冷静阈值之一；冷静阈值须与 1–72 小时整数冷静时长成对；保存强制校验 `expectedVersion` 乐观锁及 `(user_id, requestKey)` 幂等，并记入 `spending.rule` 审计日志。
  - 自然月严格按北京时间（UTC+8）划分：当月已付订单计 `spentCents`、待付占额计 `reservedCents`；同月成功退款回补当月额度，跨月成功退款不回补上月额度。
  - 下单校验严格按 **单笔限额（`per_order`）→ 月度预算（`monthly_budget`）→ 冷静阈值（`>=`）** 顺序在统一事务内判定，并发拆单受单笔 `BEGIN IMMEDIATE` 占额拦截保护；发起支付（含 `POST /member/order/:id/payments` 与 `mockPay`）再次校验下单人当前规则（按 `excludeOrderId` 排除本单自身占额）。
- **待买清单与防绕过**（[purchase-wishlist.ts](../../../server/src/purchase-wishlist.ts)、[orders.ts](../../../server/src/orders.ts)、[payments.ts](../../../server/src/payments.ts)、[app.ts](../../../server/src/app.ts)、[backup.ts](../../../server/src/backup.ts)）：
  - 新增 7 个买家受保护路由（`GET/PUT /member/spending/rules`、`GET /member/spending/summary`、`GET/POST /member/spending/wishlist*`），订单详情与列表附带只读 `spending` 月度概览。
  - 命中冷静阈值时返回 `200 { wishlistItemId, cooldownUntil, quotedTotalCents }`，不生成订单、不预扣库存、不删除购物车商品。
  - 冷静未到期前覆盖直调 `POST /member/order`、切换 `cart`/`buy-now`、调高阈值、停用规则、取消待买后马上重拍以及发起支付四条防绕过路径，均按同意图有效冷静记录拦截或继承原更晚截止时间。
  - 到期确认（`POST /member/spending/wishlist/:id/confirm`）先持久化最新报价变化并在涨降价/改满减时抛出 `409 PRICE_CHANGED` 强制买家按新金额明确二次确认；无差异时于单事务内将待买标记为 `confirmed` 并创建订单、扣减库存、占入预算；取消仅标记 `cancelled` 且不干扰其他账号额度。
  - 备份校验覆盖 `spending_rules` / `spending_reservations` / `purchase_wishlist` 计数与订单/规则归属及 JSON 完整性，拒绝占额、状态或快照篡改。
- **鸿蒙原生端实现**（[MineView.ets](../../../mixed-development-h5/features/mine/src/main/ets/presentation/views/MineView.ets)、[SpendingSettingView.ets](../../../mixed-development-h5/features/mine/src/main/ets/presentation/views/SpendingSettingView.ets)、[WishlistView.ets](../../../mixed-development-h5/features/mine/src/main/ets/presentation/views/WishlistView.ets)、[CheckView.ets](../../../mixed-development-h5/features/cart/src/main/ets/presentation/views/CheckView.ets)、[OrderDetailView.ets](../../../mixed-development-h5/features/cart/src/main/ets/presentation/views/OrderDetailView.ets)、[Index.ets](../../../mixed-development-h5/products/phone/src/main/ets/pages/Index.ets)）：
  - 在 `MineView`（非商家视图）提供 `花钱设置` 与 `待买清单` 入口；`SpendingSettingView` 顶部置顶北京时间自然月与跨月退款口径说明与确认勾选；`WishlistView` 与 `CheckView` 仅展示静态北京时间到期时刻，不使用倒计时与 AI/提醒文案；`CheckView` 清晰承接 `SPENDING_PAUSED`（跳转 `花钱设置`）与 `COOLDOWN_ACTIVE`/入待买卡片（跳转 `待买清单`）；全页采用浅/深色主题资源。

## 验证结果

| 检查项 | 实测结果 |
| --- | --- |
| 契约检查 | `node contract-kit/v1/generators/generate.ts --check` 通过（exit 0）。 |
| 服务端类型检查 | `server` 内 `npm run check`（`tsc --noEmit`）通过（exit 0）。 |
| 服务端全量测试 | `server` 内 `npm test` 共 **559/559** 通过（含 [spending-guard.test.ts](../../../server/test/spending-guard.test.ts) `SG01–SG13` 共 13 组用例，0 失败，0 跳过）。 |
| 互审边界复核脚本 | `node --test C:/Users/23203/Documents/Codex/2026-11-25/hdm-stage5-review/work/spending-boundaries.test.mjs` **3/3** 通过（见 [repair01/spending-boundaries.log](repair01/spending-boundaries.log)）。 |
| 客户端隔离全量测试 | `node --test scripts/tests/*.test.mjs` 共 **671/671** 通过（含新增 [spending-guard-native.test.mjs](../../../scripts/tests/spending-guard-native.test.mjs) 3 项，0 失败，0 跳过）。 |
| Hvigor 串行模块测试 | `models` **104/104**、`mine` **13/13**、`cart` **48/48** 全部通过（共 **165/165**，Failure=0，Error=0，Ignore=0）。 |
| 签名构建包 | 通过 `pwsh -File scripts/verify-optimization-build.ps1 -SkipH5` 构建：`mixed-development-h5-default-all-signed.app` 大小 `10,984,384` 字节，SHA256 `33BFD7A2EA03BF9F6A82152EC9421F1CEE1017FEBA17F70383F8837BCBCEA06A`，SHA1 `E40EC72591C50E44D2B2B6B0EDE83A57CC909770`，包内 H5 校验匹配；构建日志归档于 [hdm-optimization-build.log](hdm-optimization-build.log)，互审返修说明与 64 文件冻结指纹（`2a0d3c3b4828b3ec16413bc3376c0d602602b4263a3e0d62ccb518f9937faa75`）见 [repair01/README.md](repair01/README.md)。 |

## 真机验收与清理（Pura 90 API24）

### 首轮基线实测（包 SHA256 `F5EEF8668D4B19402E2D46BB9BA9A09AE4A40B27E79C664F2066797412997668`，8 张截图）

在既有 `Pura 90 API24`（`127.0.0.1:5555`，API 24）与隔离内存夹具 `127.0.0.1:3103`（临时 `rport tcp:3000 -> tcp:3103`，未传入任何测试启动参数，普通账号登录形式输入）完成浅色（[light/result.json](device/light/result.json)）与深色（[dark/result.json](device/dark/result.json)）两轮基线设备实测：

1. **花钱设置保存**（[light/01-spending-setting.jpg](device/light/01-spending-setting.jpg) / [dark/01-spending-setting.jpg](device/dark/01-spending-setting.jpg)）：勾选自然月与跨月退款说明后保存规则 `v1`（月预算 `¥100.00`、单笔限额 `¥20.00`、冷静触发 `¥15.00` / `2` 小时），展示 `已保存规则 v1` 与月度统计。
2. **结算触发单笔限额暂停**（[light/02-spending-pause.jpg](device/light/02-spending-pause.jpg) / [dark/02-spending-pause.jpg](device/dark/02-spending-pause.jpg)）：购物袋商品进入结算后点击提交，触发 `SPENDING_PAUSED` 并展示卡片（本次 `¥47.42`、单笔上限 `¥20.00`、规则 `v1`、`去调整预算` 入口），服务端订单数为 `0`。
3. **调宽上限后触发冷静待买清单**（[light/03-wishlist-waiting.jpg](device/light/03-wishlist-waiting.jpg) / [dark/03-wishlist-waiting.jpg](device/dark/03-wishlist-waiting.jpg)）：经暂停卡片前往花钱设置将单笔上限调为 `¥50.00`（规则 `v2`）后返回提交，商品转入 `待买清单`（`冷静期等待中`，显示静态北京时间 `cooldownUntil`，无倒计时，`确认下单` 禁用，服务端订单仍为 `0`）。
4. **取消待买记录**（[light/04-wishlist-cancelled.jpg](device/light/04-wishlist-cancelled.jpg) / [dark/04-wishlist-cancelled.jpg](device/dark/04-wishlist-cancelled.jpg)）：点击 `取消待买` 后状态变为 `已取消` 并回显提示 `已取消该待买记录`，服务端待买项确认 `cancelled`；基线 8 张浅/深色截图清单见 [screenshots.json](device/screenshots.json)。
5. **基线现场清理**（[light/cleanup.json](device/light/cleanup.json) / [dark/cleanup.json](device/dark/cleanup.json)）：均已恢复原始深色主题、清理端口与夹具资源。

### 返修补测：`repair01` 退货规则变化内联重确认（包 SHA256 `33BFD7A2EA03BF9F6A82152EC9421F1CEE1017FEBA17F70383F8837BCBCEA06A`，4 张截图）

在 `Pura 90 API24`（`127.0.0.1:5555`，API 24）安装返修重建包（SHA256 `33BFD7A2EA03BF9F6A82152EC9421F1CEE1017FEBA17F70383F8837BCBCEA06A`，包内 H5 校验匹配）并连接隔离内存夹具 `127.0.0.1:3103`，同样不传启动参数、以普通登录方式依次完成浅色（[repair01/light/result.json](device/repair01/light/result.json)）与深色（[repair01/dark/result.json](device/repair01/dark/result.json)）端到端实测（清单见 [repair01/screenshots.json](device/repair01/screenshots.json)）：

1. **启用冷静阈值 + 初始受限退货进待买**：买家启用规则 `v1`（冷静阈值 `¥50.00` / `1` 小时，月预算与单笔上限留空），将 `confirm-required`（`unsealed`）商品加购 3 件（`¥71.13`），结算首次提交按预期要求勾选「请先了解并确认商品的退货限制」，勾选后提交转入 `待买清单`（`冷静期等待中`）。
2. **冷静期内商家变更退货规则 + 时钟推进后触发内联重确认**（[light/01-wishlist-policy-changed.jpg](device/repair01/light/01-wishlist-policy-changed.jpg) / [dark/01-wishlist-policy-changed.jpg](device/repair01/dark/01-wishlist-policy-changed.jpg)）：商家将商品 `returnPolicy` 改回 `standard` 后推进夹具时钟 `+3,605,000 ms`（超过 1 小时冷静期），买家点击 `确认下单` 被 `RETURN_POLICY_CHANGED` 拦截（此时服务端订单数为 `0`），卡片内展开红色边框 `退货规则变化，请重新确认` 面板并展示最新规则「支持七日无理由退货」与勾选确认框。
3. **勾选新退货规则后确认下单成功**（[light/02-wishlist-policy-reconfirmed.jpg](device/repair01/light/02-wishlist-policy-reconfirmed.jpg) / [dark/02-wishlist-policy-reconfirmed.jpg](device/repair01/dark/02-wishlist-policy-reconfirmed.jpg)）：勾选「我已了解商品最新的退货限制」并点击 `确认新退货规则并下单`，成功跳转收银台（`¥71.13`），服务端确认生成 `1` 笔订单、待买项状态变为 `confirmed`。两轮 4 张新增截图已逐图核验排版清晰、浅/深色对比可读、无重叠与截断。
4. **补测现场还原与清理**（[repair01/light/cleanup.json](device/repair01/light/cleanup.json) / [repair01/dark/cleanup.json](device/repair01/dark/cleanup.json)）：均已恢复原始深色主题（`dark -> dark`）、清理 `rport tcp:3000 -> tcp:3103` 并确认 `portsRestored: true`、`fixtureExited: true`、`port3103Free: true`、`uploadsRemoved: true`，并删除临时探测脚本。
