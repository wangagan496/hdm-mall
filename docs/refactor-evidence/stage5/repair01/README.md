# 阶段 5 互审返修（hdm-stage5-fix-20261128-01 / 02）

基线分支 `mall-crazy-design-20261116`，基线 `28fdbf18ea66d055f35dd8eb9628e669f8dba95a`（零 Git 写操作）。
本轮 64 项源码/契约/客户端/测试文件冻结 SHA-256 指纹为 **`2a0d3c3b4828b3ec16413bc3376c0d602602b4263a3e0d62ccb518f9937faa75`**（清单见 [source-fingerprint.json](source-fingerprint.json)）。

## 三项问题修复与所选方案

1. **P1-1 旧 v30 库升级后当月已付不计入已花**：
   - 在 [spending-guard.ts](../../../../server/src/spending-guard.ts) 新增幂等 `backfillSpendingReservations(connection)`：按历史订单真实状态与付款/退款事实回填 `spending_reservations`（`state=1 -> reserved`，`state IN (2,3,4,5) -> settled (monthKey(paid_at ?? created))`，`state=6 & paid_at!=null -> settled (monthKey(paid_at))`，`state=6 & paid_at==null -> released`），主键 `order_id` 配合 `INSERT OR IGNORE` 与 `NOT EXISTS` 保证重入不重复入账。
   - 在 [database.ts](../../../../server/src/database.ts) 接入 `version < 31` 主迁移及既有 `v31` 库幂等补漏检查，满足 [backup.ts](../../../../server/src/backup.ts) 全量状态与金额校验。

2. **P1-2 跨月未知付款丢失占额**：
   - 在 [spending-guard.ts](../../../../server/src/spending-guard.ts) 的 `spendingSummary` 中拆分已结算实付与在途占额：`settled` 严格按付款月 `month_key = mk` 核算并维持同月退款回补、跨月退款不回补；`reserved` 改为按 `state = 'reserved' AND month_key <= mk` 持续占额，使上月未决/未知付款在新月份自然月预算判定中保持占用，待 `settle` 按真实 `paidAt` 月份结转（不重复计入）或 `release` 释放。
   - 在 [app.ts](../../../../server/src/app.ts) 的 `GET /member/spending/summary` 前调用 `orders.expireIfDue()`，使普通超时未付单可释放而 `pending` 未知付款单不误释放。

3. **P2-3 退货限制商品入待买清单后冷静到期无法确认（采用方案 A，并补齐政策变更重确认入口）**：
   - 在 [031-spending-guard.sql](../../../../server/src/migrations/031-spending-guard.sql)（及 `database.ts` 对既升 `v31` 库的列补齐）为 `purchase_wishlist` 增加 `return_policy_confirmed` 与 `expected_return_policy_token`。
   - 在 [return-policy.ts](../../../../server/src/return-policy.ts) 新增纯商品政策摘要 `policyDigest(items)`（与会话 `sessionDigest` 解耦）；[orders.ts](../../../../server/src/orders.ts) 入待买时冻结 `policyDigest(policyGoods)`，[purchase-wishlist.ts](../../../../server/src/purchase-wishlist.ts) 到期确认时若政策摘要未变则直接沿用冻结同意并通过（支持 1–72 小时跨会话确认），若政策已变则返回结构化 `409 RETURN_POLICY_CHANGED` / `RETURN_POLICY_CONFIRM_REQUIRED` 携带当前会话 `returnPolicyToken` 与 `goods`，并在确认输入契约 [contract-kit/v1/spending-guard.ts](../../../../contract-kit/v1/spending-guard.ts) 支持可选重确认字段。
   - 客户端在 [SpendingSettingPresentation.ets](../../../../mixed-development-h5/features/mine/src/main/ets/presentation/utils/SpendingSettingPresentation.ets) 补充错误映射，在 [WishlistView.ets](../../../../mixed-development-h5/features/mine/src/main/ets/presentation/views/WishlistView.ets) 补充退货规则变化内联重确认区（主题资源配色、无倒计时）。

## 变更文件清单（本轮返修涉及）

- `contract-kit/v1/spending-guard.ts`、`contract-kit/v1/vectors/spending-guard.ts`
- `server/src/spending-guard/generated.ts`、`mixed-development-h5/commons/models/src/main/ets/SpendingGuardModels.ets`、`mixed-development-h5/commons/models/src/test/SpendingGuardVectors.test.ets`
- `server/src/migrations/031-spending-guard.sql`、`server/src/database.ts`、`server/src/spending-guard.ts`、`server/src/return-policy.ts`、`server/src/purchase-wishlist.ts`、`server/src/orders.ts`、`server/src/app.ts`、`server/src/backup.ts`、`server/test/spending-guard.test.ts`
- `mixed-development-h5/features/mine/src/main/ets/presentation/utils/SpendingSettingPresentation.ets`、`mixed-development-h5/features/mine/src/main/ets/presentation/views/WishlistView.ets`
- `scripts/tests/spending-guard-native.test.mjs`
- `docs/refactor-evidence/stage5/README.md`、`docs/refactor-evidence/stage5/final-verification.json`、`docs/refactor-evidence/stage5/hdm-optimization-build.log` 及本目录证据

## 复测与验证结果

- **Codex 边界复核脚本**（[spending-boundaries.log](spending-boundaries.log)）：`node --test C:/Users/23203/Documents/Codex/2026-11-25/hdm-stage5-review/work/spending-boundaries.test.mjs` — **3/3 通过**（`legacy-paid-order: actualSpent=6000`、`cross-month-unknown: before.reservedCents=6000, newOrderStatus=409, after.spentCents=6000`、`wishlist-return-restriction: status=200`）。
- **契约检查**：`node contract-kit/v1/generators/generate.ts --check` 通过（exit 0）。
- **服务端**：`server` `npm run check`（`tsc --noEmit`）通过；`npm test` **558/558** 通过（0 失败，0 跳过，新增 `SG10`、`SG11`、`SG12`）。
- **客户端隔离全量**：`node --test scripts/tests/*.test.mjs` **671/671** 通过（0 失败，0 跳过）。
- **Hvigor 串行模块测试**：`models` **104/104**、`mine` **13/13**、`cart` **48/48** 全部通过（合计 **165/165**，Failure=0，Error=0，Ignore=0）。
- **签名构建包**：`pwsh -File scripts/verify-optimization-build.ps1 -SkipH5` 通过（[hdm-optimization-build.log](hdm-optimization-build.log)），新包 `mixed-development-h5-default-all-signed.app` 大小 `10,984,384` 字节，SHA256 **`33BFD7A2EA03BF9F6A82152EC9421F1CEE1017FEBA17F70383F8837BCBCEA06A`**，SHA1 `E40EC72591C50E44D2B2B6B0EDE83A57CC909770`。
- **设备验收说明**：既有的 `Pura 90 API24`（`127.0.0.1:5555`）在当前会话恢复时已离线（端口 `5555` 无监听，按规则未擅自新建或重启模拟器）。浅/深色 8 张基线真机截图来自返修前签名包 `F5EEF8668D4B19402E2D46BB9BA9A09AE4A40B27E79C664F2066797412997668`；本轮对 `WishlistView.ets` 仅新增异常分支下才出现的内联重确认区块（默认展示页面未变），相关行为已由 `spending-guard-native.test.mjs` 与 Hvigor 编译打包验证，若复审要求新包设备上跑重确认 UI 可在授权启动设备后补跑。

## 返修第二轮（hdm-stage5-fix-20261128-06 / 复审 05、07）

上一轮复审（review-stage5-fix-20261128-05，gpt-6.1-sol/ultra）判定 blocked，剩余 1 项 P2：`Payments.start` 在目标订单仍有效时不清理其他已过期的普通待付单，预算收紧后会把上一单的过期占额算进月度预算，误报 `SPENDING_PAUSED`。

- **修复**（[payments.ts](../../../../server/src/payments.ts)）：`start()` 进入事务前改为无条件先执行 `expireOrders(now)`，把其他到期且无 pending 付款的普通待付单清扫出去（经 `releaseStock` → `releaseSpending` 释放占额），不再依赖目标订单自身是否过期。语义保持不变：过期本单仍返回 `409 订单已超时`；确认中的未知付款单不被释放；亲友代付仍按订单 owner 判断规则。改动 +21/−2。
- **回归用例**（[spending-guard.test.ts](../../../../server/test/spending-guard.test.ts) `SG13`）：同时固定「他人过期普通占额必须释放后放行付款」与「未知付款仍占额并拦截」两个方向，并检查渠道只发起一次、过期本单仍是原超时文案。

### 本轮验证

| 检查项 | 实测结果 |
| --- | --- |
| 定点复审脚本 | `node --test payment-sequences.test.mjs`（Codex 提供，未改断言）**7/7**，原失败项转绿。 |
| 原始三例 | `node --test spending-boundaries.test.mjs` **3/3**。 |
| 服务端 | `tsc --noEmit` 通过；`npm test` **559/559**（新增 `SG13`），0 失败 0 跳过。 |
| 客户端隔离 | `node --test scripts/tests/*.test.mjs` **671/671**。 |
| 复审结论 | Codex 定点复审通过，P2 关闭，连带补测 5/5 通过；两项源码变异（还原旧清扫逻辑、误释放 pending）均被业务断言检出；判定测试侧支持交付。 |
| 设备 | 本轮无 UI 变更，未重跑设备、未重建签名包；沿用上一轮返修包的深浅两轮 4 张截图。 |

- 本轮 64 文件冻结指纹见 [fix06-fingerprint.json](fix06-fingerprint.json)（`25eff18bcd56abfea7023180c6686e87e1f5a6898a83ea40c2f97373a1f8a1d6`，算法：按路径排序后逐行 `<path>:<sha256>\n` 取 SHA-256），相对 [source-fingerprint.json](source-fingerprint.json) 仅 `server/src/payments.ts` 与 `server/test/spending-guard.test.ts` 变化。
