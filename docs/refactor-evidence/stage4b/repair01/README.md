# 阶段 4B 价保返修与性能优化归档（repair01）

- **基准分支 / 提交**：`mall-crazy-design-20261116` (`4467aa9419eb252d5d2feb1220c0d1f27b37e9b4`)
- **运行时环境**：`Node.js v24.22.3`、`SQLite 3.54.1`、`Fastify 5.12.7`（`server/node_modules/fastify/package.json` 实际安装版本；`server/package.json` 声明范围为 `^5.12.8`，未修改或重装依赖）
- **工作区约束**：未执行 `git add/commit/push/stash/reset/checkout/clean`；`023–028` 迁移、`stage4b-review.md`、`stage4b-reproduce.mjs`、Codex 验收脚本及既有封板设备截图 `docs/refactor-evidence/stage4b/device/` 保持只读未改。
- **构建与设备范围说明**：`check5` / `check6` / `check6-extra` / `check6-schema` 仅修改服务端与归档文件，客户端/原生源码未再修改；签名打包命令 `scripts/verify-optimization-build.ps1 -SkipH5` 显式传参 `-SkipH5` 未重建 H5（已校验包内 `mine-default.hsp/resources/rawfile/index.html` 与源 H5 一致，SHA-256 `60CF0418BDC79FDB49B3A065652EE4B13B8CB730A05F978249F9AFA645154EE7`），且本轮未重新执行设备 UI 验收，沿用既有不受影响的封板实拍 `docs/refactor-evidence/stage4b/device/`。

## 1. 权威联网检索与技术定型

1. **Node.js `node:sqlite` 官方文档（适用版本：Node.js v22.5.0+ / 当前本机 `v24.22.3`）**：
   - 来源 URL：`https://nodejs.org/docs/latest-v24.x/api/sqlite.html`（已核验 200 OK）
   - 采用依据：`DatabaseSync` 显式使用 `BEGIN IMMEDIATE` 事务规避延迟写锁升级并发冲突；使用有界 512 条 `StatementSync` 预编译缓存（迁移后启用，`close()` 清理）。
2. **SQLite 官方文档（适用版本：SQLite 3.8.0+ 局部索引 / 当前本机 `3.54.1`）**：
   - 来源 URL：`https://www.sqlite.org/partialindex.html`、`https://www.sqlite.org/queryplanner.html`、`https://www.sqlite.org/wal.html`（均已核验 200 OK）
   - 采用依据：迁移 `030` / `030b` 创建局部覆盖索引（`orders_paid_radar`、`cd_expiring`、`cd_idempotency_live`、`cd_order_active`、`cr_order_active`、`cr_policy_active`、`ppp_effective`）、`compensation_radar_state(id=1, last_scan_at)` 及因果锚点表 `order_audit_anchors`，结合 `ANALYZE` 与 `EXPLAIN QUERY PLAN` 消除扫描。
3. **Fastify v5 官方文档（适用：Fastify v5 / 实装 `5.12.7`，声明 `^5.12.8`）**：
   - 来源 URL：`https://fastify.dev/docs/v5.6.x/Reference/Server/`、`https://fastify.dev/docs/latest/Reference/Lifecycle/`、`https://fastify.dev/docs/latest/Reference/Server/`（200 OK，涵盖 `forceCloseConnections` / `idle` / `onClose`）
   - 采用依据：保持 `forceCloseConnections: 'idle'` 与 `onClose` 钩子优雅释放数据库与定时句柄。

## 2. 本轮修复清单（原 4 项缺陷 + `check1`–`check6` + `check6-extra` + `check6-schema`）

- **P1 #1 / `check3` 双向余额与取消备份还原一致（`server/src/balance.ts`, `payments.ts`, `orders.ts`, `after-sales.ts`, `backup.ts`, `after-sale-backup.ts`）**：
  - `orderRefundableBalance` 统一按 `F - R - (C + U)` 占额；`backup.ts` 提取共享 `isValidCancellationRefundAmount` 供 `inspectCancellations` 与 `inspectDatabase` 共用；`after-sale-backup.ts` 同步校核 `[itemsSum - total, itemsSum]`。
- **P1 #2 / `check1`–`check6` 按件事件顺序与可信事务边界（`server/src/compensation-calc.ts`, `price-radar.ts`, `balance.ts`, `compensation.ts`）**：
  - `loadPriceHistoryAudits` 联合 `product_changes`（PK `(actor_id, request_key)`）与 `promotion_changes`（PK `(request_key)`）加载 `audit_log`，以 `(domain, actor_id, product_id/promotion, request_key)` 构建可验证业务事务身份 `txScope`；**跨路由、跨商家或跨商品复用同一客户端 UUID `requestKey` 均不合并**，同一次 `/merchant/products/:id` 批量修改多规格仍合并为一帧原子快照。
  - 原篮全件（过滤退件前）顺序计算 `Q_t` 与增量分配，floor-first + 按 `sku_id ASC, unit_idx ASC` 稳定升序逐一 `+1` 分配余数，最后按在持未退件过滤输出；`orderCompensationByUnit` 按 `(created_at ASC, rowid ASC)` 与 `returnedHash` 还原。
- **P1/P2 `check6-extra` & `check6-schema` 订单因果锚点、旧 v30 兼容升级与详情保护摘要（`migrations/030b-order-audit-anchors.sql`, `database.ts`, `backup.ts`, `orders.ts`, `compensation-calc.ts`）**：
  - 通过 `030b-order-audit-anchors.sql` 创建幂等表 `order_audit_anchors(order_id, created_audit_seq, paid_audit_seq)` 与 `orders_anchor_insert` / `orders_anchor_paid` 触发器；`Database` 打开任何 `user_version >= 30` 库时若缺表/缺触发器则事务化幂等补齐，且**绝不为既有旧订单伪造历史锚点**。
  - 同一毫秒内的下单/付款/调价循环严格以 `created_audit_seq` 与 `paid_audit_seq` 定序：付款前结束的低价不补、付款后的低价再涨仍覆盖；缺乏锚点的旧库同毫秒冲突标记 `insufficientHistory: true` 停发人工核对，禁止猜数。
  - `backup.ts` 在 `order_audit_anchors` 存在时纳入备份计数与恢复，并校验锚点类型、`paid_at` 一致性、`created_audit_seq <= paid_audit_seq` 与不超过 `MAX(audit_log.id)`（同时兼容尚无该表的历史 v30 只读备份检查）。
  - `orders.ts` 移除 `protectionBrief` 中错误的 `policy.effective_at + policy.window_days * DAY_MS` 政策寿命截断，使生效期后新建并支付的订单按自身受保窗口正常返回 `protectionBrief`（同步更新 `price-protection.test.ts` 原过时用例）。

## 3. 最终实测性能与查询计划（基于最终冻结代码）

- 可复跑脚本：[benchmark-radar.mjs](file:///D:/hdm-mall/docs/refactor-evidence/stage4b/repair01/benchmark-radar.mjs)
- 原始结果文件：[benchmark-result.json](file:///D:/hdm-mall/docs/refactor-evidence/stage4b/repair01/benchmark-result.json)
- **配置对照口径说明**：本对照采用同一 `runRadar()` 函数、同一份 2,050 笔已付订单（2,000 历史出窗 + 50 在保期）与一致输出（`lastOptSummary === lastBaseSummary`），对比“仅关闭 v30 索引 + `last_scan_at` + `StatementSync` 缓存的配置对照”与“全部开启的配置”，属配置对照而非跨历史程序版本对比：
  - 关闭索引/缓存/检查点对照（20 ticks）：**`566.14 ms`**（`28.31 ms/tick`）
  - 最终开启配置（20 ticks）：**`306.19 ms`**（**`15.31 ms/tick`**，实测提速 **`1.85x`**）
- **`EXPLAIN QUERY PLAN`**：`orders_paid_radar`、`cd_expiring`、`cr_order_active`。

## 4. 最终全套验证汇总（最终冻结指纹实测）

- 全套终端原始日志：[final-checks.log](file:///D:/hdm-mall/docs/refactor-evidence/stage4b/repair01/final-checks.log)
- 签名构建原始日志：[signed-build.log](file:///D:/hdm-mall/docs/refactor-evidence/stage4b/repair01/signed-build.log)

| 验证项 | 命令 / 脚本 | 最终实测结果 |
| --- | --- | --- |
| 契约校验 | `node contract-kit/v1/generators/generate.ts --check` | 通过（`verified TS + ArkTS`） |
| 服务端类型检查 | `server`: `npm run check` (`tsc --noEmit`) | 通过（`exit 0`） |
| 服务端全量测试 | `server`: `npm test` (`node --test test/*.test.ts`) | **546 / 546 通过**（0 失败，0 跳过，`39925.3912 ms`，含 `compensation.test.ts` 24/24 与 `price-protection.test.ts`） |
| Codex 规范验收副本 | `stage4b-spec-acceptance.test.mjs` | **16 / 16 通过**（已按 `疯子架构设计方案.md:718-723` 将第 12 例修订为 `3333` / 累计退 `18333`；原 `stage4b-acceptance.test.mjs` 保持未改） |
| Codex check3 取消备份 | `stage4b-cancel-backup.test.mjs` | **3 / 3 通过** |
| Codex check4 先降后退 | `stage4b-cap-filter.test.mjs` | **2 / 2 通过** |
| Codex check4 混合新低 | `stage4b-mixed-low.test.mjs` | **1 / 1 通过** |
| Codex 后继事件边界 | `stage4b-successor-boundaries.test.mjs` | **3 / 3 通过** |
| Codex 原子组与余数 | `stage4b-event-groups.test.mjs` | **4 / 4 通过** |
| Codex 多余分分配 | `stage4b-multiple-remainder.test.mjs` | **1 / 1 通过** |
| Codex 跨路由请求键 | `stage4b-request-key-scope.test.mjs` | **1 / 1 通过** |
| Codex 同毫秒订单边界 | `stage4b-order-boundary.test.mjs` | **3 / 3 通过** |
| Codex 旧 v30 兼容重开 | `stage4b-existing-v30.test.mjs` | **1 / 1 通过**（以上 10 项 Codex 独立脚本合计 **35 / 35 通过**） |
| 客户端隔离测试 | `node --test scripts/tests/*.test.mjs` | **666 / 666 通过**（0 失败，0 跳过，`20809.8963 ms`） |
| Hvigor 原生单测 | `hvigorw.bat test --mode module --no-daemon` | **184 / 184 通过**（历史实测，ArkTS 本轮未改） |
| 签名构建与 H5 一致 | `pwsh -File scripts/verify-optimization-build.ps1 -SkipH5` | 通过（`-SkipH5` 未重建 H5；`.app` `10,714,893` bytes，SHA-256 `5515E6A31A1EFB7522A3894A531CC62797166651B669ED8D3146D0F581A0BBD3` 与包内 `index.html` 一致） |
| 真机界面证据 | 沿用 `docs/refactor-evidence/stage4b/device/` 封板实拍 | 未重跑真机 UI；8 张浅/深色实拍及报告保持未改 |
