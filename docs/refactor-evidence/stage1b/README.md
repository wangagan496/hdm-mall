# 阶段 1B 身份切换与入口整理

任务编号 stage1b-20261118-01，验证日期 2026-11-18，基线 mall-crazy-design-20261116 @ c7f052c，Node v24.22.3。

## 迁移与权限

- 020 为旧账号保留原身份，旧店主另获一条买家授予。旧表没有创建时间，原身份从历史起点计，新增买家授予使用迁移时钟。新账号记录买家默认授予，配置创建的店主身份有独立来源。保留 users.role 作为旧备份和旧迁移所需的初始身份，数据库禁止修改它。会话权限来自有效授予和会话当前身份。
- 登录优先选择当前持有的店主身份。切换检查授予，保持同一 token，递增该会话的身份版本，在同一事务写入带操作当时身份的审计。请求同时声明 X-HDM-Identity 和 X-HDM-Identity-Revision，旧请求、缺声明和来回切换后的旧版本返回 409 IDENTITY_CHANGED。有效会话可从 409 响应恢复身份上下文，原业务请求不执行。
- 报价及退货承诺确认凭据绑定登录会话、买家身份和会话身份版本。已切换上下文的迟到响应不能写回当前客户端会话。首页配置按账号和身份保存，修订号防止覆盖其他设备的修改。白名单来自当前入口，订单、售后、客服及包含代付代收订单的亲友入口保持可见。
- 单店店主以买家身份可购物付款，评价、退货、仅退款和已付款取消申请会被拦截。店主身份处理自己订单的取消审核和售后处理也会被拦截。普通买家原有的亲友代付和代收边界保持，店主必须在买家身份下才能进入这些流程。
- 新备份按操作时间查询身份授予，售后和取消动作保留 acting_identity，系统动作不记用户身份。旧备份继续按归档版本使用原规则校验，再依序迁移。历史商家以原身份操作本人订单的兼容范围截止到额外买家授予的迁移时刻，仍须通过原订单归属和历史授予校验。

## 离线验证

| 检查 | 阶段 1A | 阶段 1B |
| --- | --- | --- |
| 服务端 TypeScript | 通过 | 通过 |
| 服务端常规与随机顺序 | 各 406 项 | 各 432 项，零失败、零跳过，随机种子 271113 |
| 契约共同向量 | 报价 24 项 | Node 与生成的 TS 解析器通过报价 24 项及身份 18 项；ArkTS 以模块测试记录为准 |
| H5 桥接、类型检查与移动构建 | 通过 | 12 个桥接方法、vue-tsc 和 pnpm build:mobile 通过，移动产物写入原生 rawfile |
| H5 资料页定向回归 | 并入根目录测试 | 16 项通过，零失败、零跳过 |
| 客户端根目录常规与随机顺序 | 见阶段 1A 记录 | 各 634 项通过，零失败、零跳过，随机种子 271113 |
| Hvigor 模块测试 | 见阶段 1A 记录 | 129 项通过，结果以各模块 test_result.txt 为准 |
| 签名 APP 与内嵌 H5 核对 | 见阶段 1A 记录 | 通过，内嵌 index.html 与移动构建产物一致 |

服务端原始日志位于 server/。初次使用 npm 转发移动构建时，参数被当作项目目录，按仓库脚本改用 pnpm 后通过。受限命令曾拒绝读取现有 pnpm 依赖，经批准后运行正常。

## 初次 Native 接手前检查点

本轮按接手请求停在离线验证阶段。旧 Native 子任务状态为 interrupted，已落盘的改动全部保留，本轮没有启动替代子任务。身份模型、网络请求头及迟到响应检查、会话切换、首页布局存取和入口整理页已写入。我的、首页、亲友中心、原生资料桥接与商家页面已接入当前身份。

- 已通过服务端类型检查、两轮各 432 项回归、Node/TS 共同向量 42 项、H5 桥接/类型/移动构建。根目录的资料页定向用例 16 项，以及原生写请求、会话页和桥接定向用例 16 项分别通过。
- 第一次根目录全量回归在原生工作进行中运行，两轮各发现 633 项，常规 597 通过、36 失败。随后更新了多组夹具，当前工作区仍须重跑常规和随机顺序（seed 271113），未把中途结果当作最终结果。原来的失败日志保留在本目录。
- 首次签名构建在网络层报两处 ArkTS 类型错误，已改显式类型，第二次构建已越过网络模块。签名第二轮停在存储模块，commons/storage/Index.ets 第 8、9 行重复导出，commons/storage/src/main/ets/UserSession.ets 第 23 行的对象展开被 ArkTS 拒绝，详见 signed-build-attempt2.log。PrepareSharedHarResource 还出现 getName 错误，应在上述编译错误修复后重查。
- 接手范围包括修复上述 ArkTS 错误、完成亲友页和身份切换测试夹具、补跑根目录两轮测试、Hvigor 模块测试、签名和 SHA256，并在设备恢复在线后完成真实入口及截图验收。根目录扫描和 Hvigor 模块测试应串行。临时检查脚本 scripts/.stage1b-checks.ps1 保留给续做，用完删除。
- 工作树仍位于 mall-crazy-design-20261116，阶段改动均未提交。另有审批设置文件 .codex/config.toml，本轮按接手请求保留。

## 接手后的离线验证结果

已删除 `IdentityLayouts` 的重复导出，并在身份更新时用显式字段复制保留全部账号资料，修复 ArkTS 不支持的对象展开。签名构建已通过，`PrepareSharedHarResource` 的 `getName` 错误未在通过的构建中复现。

- 根目录常规和随机顺序各 634 项通过，详见 [常规日志](client-test-takeover2.log) 和 [随机日志](client-test-seed-271113-takeover2.log)。亲友测试分别使用买家和店主身份，验证切回同一身份后旧结果和旧确认不会写回。
- Hvigor 首次返回成功但资料桥接测试中仍有一项失败。更新夹具并补上身份和身份版本不匹配的用例后，重跑 [模块测试](hvigor-module-takeover2.log)，各模块结果合计 129 项成功。
- [签名构建](signed-build-summary-takeover1.log) 生成 `mixed-development-h5-default-all-signed.app`，大小 9,935,799 字节，SHA256 为 `8168A4E03043D719293C68707E4A2B91C875C9EAFC39AC59D6AEA08865AEBCE5`。

## 设备验收

接手前设备离线，见 [初始检查](device-preflight.json)。接手后复用现有 Pura 90 API24，核对目标和 API 后安装了上述 SHA256 对应的签名包，在独立 3103 夹具上完成 [设备验收](device-takeover3/result.json)。测试结束后已关闭夹具并恢复原端口映射。

- 浅色模式下店主隐藏「商品管理」，切换到买家后隐藏「首页轮播」，确认服务端按身份分别保存。进入结算页后原路退出，未下单或付款，见 [结算截图](device-takeover3/light-03-checkout-before-payment.png)。
- 来回切换时登录凭证保持不变、身份版本递增。浅色和深色模式下重新进入入口整理，两份布局分别恢复，见 [深色买家](device-takeover3/dark-06-buyer-layout-restored.png) 与 [深色店主](device-takeover3/dark-07-merchant-layout-restored.png)。
- 自家商品评价、三种售后申请和取消审核的拒绝由服务端回归覆盖，设备验收范围为身份切换、布局和付款前结算流程。

## 返修 stage1b-20261118-02

- 入口整理的列表从身份标题下方开始，锁定项右侧显示「始终显示」，原来的禁用开关已移除。亲友中心、订单和售后、人工客服分别显示保留原因。普通买家保留共用的「入口整理」入口，当前身份标签和身份切换按钮只出现在多身份账号。
- 客户端常规及随机顺序各 634 项通过，零失败、零跳过，随机种子 271113。见 [常规回归](client-test-repair02.log) 和 [随机回归](client-test-seed-271113-repair02.log)。
- Hvigor 模块测试共 129 项，零失败、零跳过。模型 42、网络 5、购物袋 42、分类 6、首页 26、我的 8。首次在生成 ModuleStructure.ets 时被 Windows 拒绝写入，重跑完成。见 [首次日志](hvigor-module-repair02.log) 和 [通过日志](hvigor-module-repair02-rerun.log)。
- 签名包为 mixed-development-h5-default-all-signed.app，9,941,138 字节，SHA256 为 90F3299509790D9E1BD9002BF112F9F09810BAEA803005819E6D81BFA2A2164E，包内 H5 与移动构建产物一致。见 [构建摘要](signed-build-summary-repair02.log) 和 [构建日志](signed-build-repair02.log)。返修只改客户端，服务端沿用阶段 1B 已有 432 项两轮通过的记录。
- device-takeover2 已移除 5 张中间截图和 6 份布局文件，保留 7 份日志与数据记录。device-takeover3 是初版签名包的设备证据，10 张截图已压缩为 720 像素宽，最大 169,909 字节。
- 已清理此次使用的临时检查脚本。仓库目录下未被 Git 跟踪的 .codex/config.toml 是当前项目的本机审批配置，继续保留在原位置。

### 返修包设备验收

复用 Pura 90 API24，在同一份新签名包上用 3103 隔离夹具完成浅色和深色两轮。两轮都先确认入口原先可见，再通过入口整理保存，核对原页面控件已消失及服务端分别保存了 merchant-products、home-banner。普通账号的有效授予只有买家。

探针在内存中对 App 登录返回的 token 和每次真实切换请求中的 Bearer 计算摘要，并与隔离数据库中同一个会话记录比较。两轮分别是各自一次店主登录后的连续三次切换，身份版本都从 0 递增到 1、2、3，六次比较均为 true。切换后的「我的」仍显示同一店主账号和新身份，页面未回到登录。证据只留比较布尔值、登录序号和身份版本，见 [验收记录](device-repair3/result.json)。夹具已退出，3103 端口释放，上传临时目录删除，设备原主题和反向映射均恢复。

14 张正式截图均为 720 × 1558 像素，最大 97,729 字节。device-repair 与 device-repair2 为前两次探针试跑，保留失败证据。

| 浅色 | 深色 | 截图与布局断言看到的内容 |
| --- | --- | --- |
| [店主的我的](device-repair3/light-01-merchant-mine.jpg) | [店主的我的](device-repair3/dark-01-merchant-mine.jpg) | 当前为店主身份，能点「切换为买家身份」，隐藏前的商品管理可见。 |
| [买家首页](device-repair3/light-02-buyer-banner-hidden.jpg) | [买家首页](device-repair3/dark-02-buyer-banner-hidden.jpg) | 保存隐藏轮播后，首页仍有爆款推荐，轮播控件及该区域消失。 |
| [商品管理隐藏后](device-repair3/light-03-merchant-product-hidden.jpg) | [商品管理隐藏后](device-repair3/dark-03-merchant-product-hidden.jpg) | 仍是店主身份，库存管理和售后处理可见，商品管理入口消失。 |
| [普通买家的我的](device-repair3/light-04-ordinary-buyer-mine.jpg) | [普通买家的我的](device-repair3/dark-04-ordinary-buyer-mine.jpg) | 显示普通账号和亲友中心，页面不显示身份标签或切换按钮，共用入口整理仍可访问。 |
| [切到买家身份后](device-repair3/light-05-buyer-after-switch.jpg) | [切到买家身份后](device-repair3/dark-05-buyer-after-switch.jpg) | 仍是原店主账号，页面显示买家身份及「切换为店主身份」。 |
| [店主入口整理](device-repair3/light-06-merchant-layout.jpg) | [店主入口整理](device-repair3/dark-06-merchant-layout.jpg) | 店铺订单紧接标题，订单、售后、客服三行显示原因和「始终显示」标签，商品管理开关已关闭。 |
| [买家入口整理](device-repair3/light-07-buyer-layout.jpg) | [买家入口整理](device-repair3/dark-07-buyer-layout.jpg) | 首页搜索紧接标题，订单、亲友、客服三项显示各自原因及「始终显示」，轮播开关已关闭。 |
