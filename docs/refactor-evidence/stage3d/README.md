# 阶段 3D 买家追加“处理后感受”与售后处理记录关联位

任务 `hdm-stage3d-20261123-01` 及返修 `hdm-stage3d-20261123-02`，基线 `mall-crazy-design-20261116` / `f4413cc`。

## 实现与边界

- **迁移 027**（[027-evaluation-followups.sql](../../../server/src/migrations/027-evaluation-followups.sql)）：新增 `evaluation_followups`（`order_id` 主键保证每条评价至多追加一次，并附带 `BEFORE UPDATE` / `BEFORE DELETE` 触发器防篡改删除）与售后处理记录预留表 `evaluation_service_records`（限制 `source='system-case'`，本阶段不写入任何数据）。未改动迁移 `023–026`。
- **追加接口与统一资格口径**（[evaluations.ts](../../../server/src/evaluations.ts)、[orders.ts](../../../server/src/orders.ts)、[app.ts](../../../server/src/app.ts)）：
  - 读接口的 `canFollowup` 与写接口 `POST /member/order/:id/evaluation/followup` 共用同一个判定函数 `followupEligibility(db, orderId)`：校验订单已评价、尚未追加过、无进行中售后（`pending`/`awaiting-return`/`returned`/`refunding`）、存在已结束售后（`refunded`/`completed`/`closed`/`rejected`/`refund-rejected`），且**该订单关联的所有 `refunds`（含货款退款与独立运费退款）均已 `succeeded`**。即使售后单已因货款到账进入 `refunded`，只要运费退款仍处于 `pending` 或 `failed`，读写两侧同步拒绝并给出中文提示。
  - 写接口同时校验买家本人、内容 5–300 字、`checkPublicContent` 敏感词检查及不含手机号/邮箱/订单私密信息；追加后原评价、逐条承诺结果、尺码评价、复核结论保持逐字节不变。
- **追加后原评价锁定的设计取舍（D15）**：
  - 按决定 **D15**（“售后处理后原问题和原评价保留，处理记录由系统关联案件、买家可追加处理后感受”），阶段 3D 在买家尚未追加处理后感受前，仍保留 15 天内主动改评（并保留修改历史）的能力；一旦买家提交“处理后感受”，`saveEvaluation` 返回 `409` 锁定原评价不可再改写。这一取舍确保售后结清后的真实追加与当时的原评价构成不可改写的完整对照，防止后续改写原问题或抹平前因后果。
- **公开与商家展示及预留关联位**（[evaluation-page.ts](../../../server/src/evaluation-page.ts)、[evaluations.ts](../../../server/src/evaluations.ts)）：
  - 公开分页 `/goods/:id/evaluate/page` 与商家列表 `/merchant/goods/:id/reviews` 分别返回脱敏后的 `followup`（北京日期）。
  - **阶段 6 接入前**：`evaluationServiceRecord` 在买家订单详情、商品详情评价页、商家评价列表三处一律固定返回 `{ status: 'pending', connected: false, label: '处理记录待接入', records: [] }`，与 `evaluation_service_records` 表中是否存在残留行无关，且页面不展示任何虚构的处理动作、结论或金额。**放开条件**：仅在阶段 6 人工举证申诉与真实案件系统上线后，确认记录由系统关联真实已受理/结案的案件（具备有效 `case_id`、关联 `after_sales` 与真实处理事实、非商家自填）时才在对应阶段放开读取。
- **备份恢复校验**（[backup.ts](../../../server/src/backup.ts)）：`manifestSchema` 与 `inspectDatabase` 支持到版本 27，纳入 `evaluation_followups` 与 `evaluation_service_records`，并校验追加人归属、买家历史身份、创建时间、已结束售后依据及当时已建退款的 `succeeded` 状态。
- **客户端与页面**（[BusinessModels.ets](../../../mixed-development-h5/commons/models/src/main/ets/BusinessModels.ets)、[goods.ets](../../../mixed-development-h5/features/home/src/main/ets/domain/models/goods.ets)、[GoodsComment.ets](../../../mixed-development-h5/features/home/src/main/ets/presentation/components/GoodsComment.ets)、[OrderDetailView.ets](../../../mixed-development-h5/features/cart/src/main/ets/presentation/views/OrderDetailView.ets)、[EvaluationView.ets](../../../mixed-development-h5/features/cart/src/main/ets/presentation/views/EvaluationView.ets)、[ReviewManageView.ets](../../../mixed-development-h5/features/mine/src/main/ets/presentation/views/ReviewManageView.ets)）：按资格显示“追加处理后感受”入口，追加后原评价与追加内容均为只读；商品详情评价卡与订单评价页分开展示“买家追加 · 时间”及“售后处理记录：处理记录待接入”；商家端只读展示追加内容，无编辑或删除入口。

## 验证结果与沙箱边界

| 检查项 | 实测结果 |
| --- | --- |
| 契约检查 | `node contract-kit/v1/generators/generate.ts --check` 通过（exit 0）。 |
| 服务端类型检查 | `server` 内 `npm run check`（`tsc --noEmit`) 通过（exit 0）。 |
| 服务端常规测试（沙箱内） | `npm test` 共 512 项（基线 506 + 3D 新增 6 项 [evaluation-followups.test.ts](../../../server/test/evaluation-followups.test.ts)），通过 503 项，零跳过；9 项因沙箱禁止 `127.0.0.1` 套接字连接（`connect EACCES`）及符号链接创建（`symlink EPERM`）失败。 |
| 服务端随机两轮（沙箱内） | 种子 `271113` 与 `271114` 各 512 项，均通过 503 项，零跳过；同一 9 项因沙箱网络/符号链接限制失败。 |
| 客户端隔离测试（沙箱内） | `node --test scripts/tests/*.test.mjs` 常规与种子 `271113` 各 659 项（基线 657 + 3D 新增 2 项 [evaluation-followups.test.mjs](../../../scripts/tests/evaluation-followups.test.mjs)），通过 658 项，零跳过；[client-environment.test.mjs](../../../scripts/tests/client-environment.test.mjs#L146-L152) 1 项因沙箱禁止 `spawnSync pwsh`（`EACCES`）失败。 |
| 边界核查 | 迁移 `023–026` 未改动；未执行任何 git 写操作。 |
| Hvigor / 签名构建 / 设备 | 本轮按返修指示不跑设备与签名构建；沙箱内无法提权运行 Hvigor。 |

## 设备验收

任务 `hdm-stage3d-device-20261123-04`（取得完整权限后复测与真机双向验收）：

| 检查项 | 实测结果 |
| --- | --- |
| 服务端全量测试 | TypeScript `npm run check` 通过；常规 `npm test` 512/512 通过（零跳过）；随机种子 `271113` 与 `271114` 均为 512/512 通过（零跳过）。 |
| 客户端隔离全量测试 | 常规与随机种子 `271113` 均为 659/659 通过（零跳过）。 |
| Hvigor 模块测试 | 12 个模块合计 168/168 通过（`models` 80、`cart` 42、`home` 27、`mine` 8、`category` 6、`network` 5，其余 6 个模块均为 0；失败、错误、忽略均为 0）。 |
| 签名构建包 | 通过 `pwsh -File scripts/verify-optimization-build.ps1 -SkipH5` 构建：`10,496,522` 字节，SHA256 `367406B6CF93A4E9DCF9CC339CF1E00D895A150F8D783BD3A0D5DB0FF9C409EE`。见 [optimization-build.log](optimization-build.log)。 |
| 真机浅色与深色验收 | 在既有 `Pura 90 API24`（`127.0.0.1:5555`，API 24）与隔离测试夹具 `127.0.0.1:3103`（`rport tcp:3000 -> tcp:3103`）完成浅色（`orderA=bbf60306-190d-4687-9146-d99a0df57784`、`orderB=d5e576f8-7b40-4184-8999-3ec30a77b842`）与深色（`orderA=8aff2768-f44b-4a66-a3b9-c05e6416fc77`、`orderB=43ac8b81-7f89-4037-8019-d302e0b1e4ea`）两轮真机走查：1）已完成售后订单点击“追加处理后感受”提交后显示“买家追加 · 时间”与追评正文；2）同商品详情页展示“买家追加”与“售后处理记录：处理记录待接入”（`connected=false`、`records=[]`，无虚构动作/结论/金额）；3）订单评价页原评价与原评分（商品 2 分 / 物流 3 分 / 售后 3 分）只读且保持不变，再编辑由服务端 HTTP 409 中文拒绝（`已追加处理后感受，原评价不可修改`）；4）商家端评价管理页只读展示追评，无编辑或删除按钮；5）未完结售后（`pending`）订单详情页无追评入口。 |
| 截图与核验目录 | 共 8 张 `.jpg`（深浅各 4 张，已逐张读图核对无遮挡、无溢出、文字清晰）：[screenshots.json](device/screenshots.json)、[light/result.json](device/light/result.json)、[dark/result.json](device/dark/result.json)。浅色：[01-order-entry.jpg](device/light/01-order-entry.jpg)、[02-evaluation-readonly.jpg](device/light/02-evaluation-readonly.jpg)、[03-goods-detail.jpg](device/light/03-goods-detail.jpg)、[04-merchant-review.jpg](device/light/04-merchant-review.jpg)；深色：[01-order-entry.jpg](device/dark/01-order-entry.jpg)、[02-evaluation-readonly.jpg](device/dark/02-evaluation-readonly.jpg)、[03-goods-detail.jpg](device/dark/03-goods-detail.jpg)、[04-merchant-review.jpg](device/dark/04-merchant-review.jpg)。 |
| 清理与还原 | 两轮结束后均已还原原深色主题（`dark -> dark`）、释放 `3103` 端口、清空 `fport`（`[Empty]`）、相册数量保持 `1 -> 1`，并删除临时脚本、夹具上传临时目录及设备端 `/data/local/tmp/stage3d*` 临时文件（未生成拼图或 PNG 残留）。见 [light/cleanup.json](device/light/cleanup.json)、[dark/cleanup.json](device/dark/cleanup.json)。 |
