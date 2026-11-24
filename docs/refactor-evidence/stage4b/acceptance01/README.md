# 阶段 4B 独立只读验收报告（acceptance01）

- **验收任务编号**：`hdm-stage4b-acceptance-20261124-01`
- **关联任务**：`hdm-stage4b-20261124-01`（实现）、`hdm-stage4b-repair-opt-20261124-01`（返修）、`hdm-stage4b-repair-review-20261124-01`（互审）
- **项目与基线**：`D:/hdm-mall`，分支 `mall-crazy-design-20261116`，`HEAD` = `4467aa9419eb252d5d2feb1220c0d1f27b37e9b4`（4B 改动均在工作区，未执行任何 Git 写入或依赖变更）
- **最终验收结论（执行方独立复验）**：**通过**（步骤 1–5 全部实测通过，无阻断级 P0/P1/P2 问题；步骤 6 真机 UI 与步骤 7 重签名构建按只读验收边界未重跑，已明确列于未覆盖边界）

---

## 1. 指纹与清单复核（Step 1）

- **基准清单**：`C:/Users/23203/Documents/Codex/2026-11-24/666/work/4b-successor-check6/snapshot-before.json`
- **实际验证结果**：逐文件重算字节数与 SHA-256，**`60 / 60` 全部一致**（`total = 60, ok = 60, bad = 0`）。
- **整包指纹实测**：`fb17031b686eb39fd43569d044e490d4153179d82ba677dca02201c3ea914c99`（与清单 `fingerprint` 完全一致）。

## 2. 回归测试复验（Step 2）

原始输出归档：[regression.log](file:///D:/hdm-mall/docs/refactor-evidence/stage4b/acceptance01/regression.log) 与 [hvigor.log](file:///D:/hdm-mall/docs/refactor-evidence/stage4b/acceptance01/hvigor.log)。

| 检查项 | 实际命令 | 实测结果摘要 |
| --- | --- | --- |
| 服务端类型检查 | `server`: `npm run check` (`tsc --noEmit`) | **通过**（`exit 0`） |
| 服务端全量测试 | `server`: `npm test` (`node --test test/*.test.ts`) | **546 / 546 通过**（`0` 失败，`0` 跳过，`39386.1256 ms`） |
| 客户端隔离测试 | 仓根 `node --test scripts/tests/*.test.mjs` | **666 / 666 通过**（`0` 失败，`0` 跳过，`16869.1429 ms`） |
| 契约校验 | `node contract-kit/v1/generators/generate.ts --check` | **通过**（`verified TS + ArkTS`） |
| Hvigor 串行测试（无并发扫描） | 依次单独执行 `--mode module -p module=cart@default` / `mine@default` / `models@default -p product=default --no-daemon` | **全部成功**：`cart` `BUILD SUCCESSFUL in 30 s 799 ms`（128 tasks）；`mine` `BUILD SUCCESSFUL in 29 s 783 ms`（128 tasks）；`models` `BUILD SUCCESSFUL in 14 s 65 ms`（38 tasks） |

## 3. 证据一致性核对（Step 3）

核对对象为 `D:/hdm-mall/docs/refactor-evidence/stage4b/repair01/` 下 `README.md`、`final-verification.json`、`final-checks.log`、`signed-build.log` 与实际磁盘源码及签名构建产物：

1. **源码与证据哈希清单**：逐项重算 `repair01/final-verification.json` 声明的 **`23 / 23`** 个文件 `size` 与 `sha256`（含核心后端实现、迁移 `030` / `030b`、前端未改文件及基准/日志产物），**全部吻合（23 ok, 0 bad）**。
2. **历史构建产物与 H5 校验**：
   - 未重新构建（沿用历史构建产物 `D:/hdm-mall/mixed-development-h5/build/outputs/default/mixed-development-h5-default-all-signed.app`）。
   - 实测 `.app` 大小 **`10,714,893` bytes**、SHA-256 **`5515E6A31A1EFB7522A3894A531CC62797166651B669ED8D3146D0F581A0BBD3`**，与 `signed-build.log` 和 `final-verification.json` 完全一致。
   - 执行 `scripts/verify-package-web.ps1 -AppPath ...` 实测返回 `MATCH mine-default.hsp/resources/rawfile/index.html SHA256 60CF0418BDC79FDB49B3A065652EE4B13B8CB730A05F978249F9AFA645154EE7`，包内 H5 与源输出一致。
3. **测试与运行环境记录**：`repair01/final-checks.log`（`126,365` bytes，SHA-256 `F160CFCE29F8727DC99735E3772D1BD1166FCE5D1A1F5A9FB384FBCA1CB5AC33`）与本次实测 `546/546`、`666/666`、`contract-kit` 结果一致；`final-verification.json` 明确区分了实际安装 Fastify `5.12.7` 与声明范围 `^5.12.8`。

## 4. 迁移与数据安全复验（Step 4）

隔离验证输出见 [independent-verify.json](file:///D:/hdm-mall/docs/refactor-evidence/stage4b/acceptance01/independent-verify.json)（`step4` 段，临时目录测试并在 `finally` 清理）：

- 构造剔除 `order_audit_anchors`、`orders_anchor_insert`、`orders_anchor_paid` 的 `user_version = 30` 历史库后以当前 `Database` 重开：
  - `030b-order-audit-anchors.sql` 幂等补齐锚点表与触发器，未崩溃且保持 `user_version = 30`。
  - **不伪造历史锚点**：已有订单 `oDistinct` 与 `oSame` 在 `order_audit_anchors` 中均为 `undefined`。
  - 缺锚点但同毫秒调价冲突的 `oSame` 调用 `computeOrderCompensation` 返回 `insufficientHistory: true`、`cappedCents: 0`，`runRadar` 不建草稿；异毫秒 `oDistinct` 正常得出 `[1000]`。
- 重开库通过真实接口下新单并付款后自动写入 1 条锚点记录；`createBackup` -> `verifyBackup` -> `restoreBackup` 均在清单与恢复报告中准确保留 `counts.order_audit_anchors = 1` 并通过校验。

## 5. 关键业务孤立复验（Step 5）

完整结构化实测见 [independent-verify.json](file:///D:/hdm-mall/docs/refactor-evidence/stage4b/acceptance01/independent-verify.json)（`step5` 段，内存库独立运行）：

1. **三类渠道状态占用余额验证（实付 `10000`，补差 `3000`）**：
   - `channel_status = 'pending'`：取消退款 `7000`，`7000 + 3000 = 10000`（未超实付）。
   - `channel_status = 'unknown'`：取消退款 `7000`，`7000 + 3000 = 10000`（未超实付）。
   - `channel_status = 'executed'`：取消退款 `7000`，`7000 + 3000 = 10000`（未超实付）。
2. **多次降价增量、单笔上限与活动总预算同时成立（`K = 2500`, `B = 3500`）**：
   - 订单 A、B 同在 `10000 -> 9000` 均获 `1000` 并确认后，总预算剩 `1500`。
   - 再降至 `7000`：订单 A（先付款）新增草稿 `cappedCents = 1500`（`min(2000, 2500 - 1000)`，受单笔上限约束为 `1500`）且进入 `pending`；订单 B 同算得 `1500` 但因活动余额耗尽落为 `pending_budget`。
3. **退件后重算与额度不转移（2 件实付 `20000`, `K = 5000`）**：
   - 降至 `7000` 先产生 `5000` 草稿（每件分摊 `2500`）；收货并同意退回 1 件后再运行 `runRadar`，原 `5000` 草稿状态转为 `cancelled`，重新签发 `2500` 草稿（已退件份额未转给留件）。
4. **长期生效政策第 8 天新单（`windowDays = 7`）**：
   - 政策生效 8 天后新建并支付订单，详情接口 `GET /member/order/:id` 返回非空 `protectionBrief`（`windowDays: 7`），随后降价至 `8500` 雷达正常生成 `1500` 补差草稿。

## 6. 设备、构建与残留情况（Step 6 / Step 7 & 边界）

- **Step 6（设备，可选）**：**未重跑真机 UI 验收**；仅执行只读 `hdc list targets` 确认 `127.0.0.1:5555`（`Pura 90 API24`）在线。因客户端/原生源码在终版周期内未改动，为遵守“不清设备数据、不改夹具”只读约束，沿用既有未改动的 `docs/refactor-evidence/stage4b/device/` 深浅双色封板实拍证据。
- **Step 7（构建，可选）**：**未重建**，沿用历史签名包 `D:/hdm-mall/mixed-development-h5/build/outputs/default/mixed-development-h5-default-all-signed.app`（SHA-256 `5515E6A31A1EFB7522A3894A531CC62797166651B669ED8D3146D0F581A0BBD3`）。
- **发现的残留情况（均属信息性/低严重性，不阻塞验收）**：
  1. **低 / 已知环境差异**：`server/package.json` 声明 `"fastify": "^5.12.8"` 而 `server/node_modules/fastify/package.json` 实际版本为 `"5.12.7"`，已在 `repair01` 文档如实区分且遵循约束未调整依赖。
  2. **低 / 历史非阻断告警**：`hvigorw.bat` 编译日志含既有无关告警（如 `DownLoadManager.ets:26:17` `ArkTS:WARN`），不影响三模块 `BUILD SUCCESSFUL`。
- **明确未覆盖边界**：
  1. 本次验收未重跑真机设备 UI 交互与新深浅双色截图（Step 6 跳过）。
  2. 本次未重新执行 H5 重建及 HarmonyOS `.app` 重新打包（Step 7 沿用历史签名包，已验包内 H5 与源产物 SHA-256 一致）。
  3. 实际支付/退款渠道 4C 外部真通道调用未联网实扣（按项目阶段边界使用 `MockPaymentChannel` 与数据库渠道状态复验）。

## 7. 本次新增验收证据文件（`acceptance01`）

- [README.md](file:///D:/hdm-mall/docs/refactor-evidence/stage4b/acceptance01/README.md)（本独立验收报告）
- [regression.log](file:///D:/hdm-mall/docs/refactor-evidence/stage4b/acceptance01/regression.log)（`tsc`、`server npm test` 546 项、客户端 666 项、`contract-kit` 原始日志）
- [hvigor.log](file:///D:/hdm-mall/docs/refactor-evidence/stage4b/acceptance01/hvigor.log)（`cart` / `mine` / `models` 串行 Hvigor 模块测试原始日志）
- [independent-verify.json](file:///D:/hdm-mall/docs/refactor-evidence/stage4b/acceptance01/independent-verify.json)（Step 4 `v30` 无锚点兼容升级与备份/恢复、Step 5 四类关键业务场景结构化实测结果）
