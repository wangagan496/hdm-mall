# 惠多美阶段1A U1：Node24补丁升级

任务编号 stage1a-u1-20261117-01；执行日期2026-11-17，时区Asia/Shanghai；执行证据已封版，待原Claude Desktop会话独立复核，本包不生成投递回执。

## 本次结果

系统Node由v24.16.0升级为v24.22.3，npm由11.13.0升级为官网MSI随附的11.19.1；pnpm保持11.9.0。服务端常规/随机均362/362，客户端常规/随机均617/617，全部零失败、零取消、零跳过、零todo；server类型检查与H5类型检查退出码均0。测试发现数量与阶段0完全一致。

仅修改H5的package.json和pnpm-lock.yaml两份跟踪文件及本证据目录；未改业务代码、server依赖或H5 engines；未运行mobile构建、Hvigor、签名构建或设备操作。报价三件套和“拆开看看”页属于下一任务。

## 开工核对与材料

仓库D:/hdm-mall，分支mall-crazy-design-20261116，HEAD 6bb5e75e83b77f81b71aa8991408f11600ec3007，开工工作区干净；已读最终方案阶段1A及最终检查表U1行、技术进化分析10.6及10.7 U1行、执行须知全文；基线来自docs/refactor-evidence/baseline/checks.json及README，系统Node v24.16.0、server 362、客户端617、Hvigor83。

## 目标版本、查询来源与时间

查询起止：2026-11-17T20:37:18.8490988+08:00 至 2026-11-17T20:37:23.1352953+08:00。

| 项目 | 本次核实结果 | 来源 |
| --- | --- | --- |
| Node24最新正式版 | v24.22.3，发布于2026-11-10，LTS Krypton | https://nodejs.org/dist/index.json |
| @types/node 24系最新正式版 | 24.19.2 | https://registry.npmjs.org/@types%2fnode |
| @tsconfig/node24最新正式版 | 24.0.6，与latest标签相同 | https://registry.npmjs.org/@tsconfig%2fnode24 |

Node按纯v24.x.y版本数字排序；npm类型包按纯24.x.y排序；tsconfig按纯正式语义版本排序；均排除预发布，未选择Node25/26等主版或Node26类型，未升级TS7。11/16技术报告仅作对照，本次数值来自上述即时请求。原始精简查询结果见version-query.json。

## 安装包校验与覆盖安装

下载地址：https://nodejs.org/dist/v24.22.3/node-v24.22.3-x64.msi

校验表：https://nodejs.org/dist/v24.22.3/SHASUMS256.txt

官网SHA256：4a1ab5bdec5434bae58efae6c3e5077a011f6f1e76d2b47b7b10af043f7db545

本地SHA256：4a1ab5bdec5434bae58efae6c3e5077a011f6f1e76d2b47b7b10af043f7db545

结论：完全一致；33357824字节；Authenticode Valid，签名方CN=OpenJS Foundation, O=OpenJS Foundation, L=San Francisco, S=California, C=US；仅校验通过后才调用msiexec。

安装命令为msiexec /i 临时MSI /passive /norestart INSTALLDIR=原系统Node目录 /L*v 临时日志，退出码0；2026-11-17T20:38:51.6491992+08:00开始，2026-11-17T20:40:00.1252627+08:00完成；未使用绕过UAC的方式，未记录到需要暂停等用户点击的阻碍。安装包位于系统临时目录，安装完成后已删除并复核不存在；未安装或升级其他全局工具。

覆盖目录与新shell的process.execPath：C:\xunlei\node-v24.16.0-win-x64\node-v24.16.0-win-x64\node.exe；目录名仍保留24.16.0，但其中实际二进制已是v24.22.3，不以目录名称判断版本。新开的PowerShell中node -v、npm -v、where.exe node均已记录；PATH首个Node命中该覆盖路径。MSI在机器PATH增加了同目录带末尾反斜线的项，原目录项保留，两者指向同一个新二进制；未手工改PATH或移动目录。

| 工具 | 安装前 | 安装后 | 结论 |
| --- | --- | --- | --- |
| 系统Node | v24.16.0 | v24.22.3 | PATH首项命中新二进制 |
| npm | 11.13.0 | 11.19.1 | MSI配套版本 |
| pnpm | 11.9.0 | 11.9.0 | 原启动文件SHA256一致，未全局安装 |
| DevEco随附Node | v24.14.1 | v24.14.1 | SHA256前后一致，未改动 |

DevEco Node：C:\Program Files\Huawei\DevEco Studio\tools\node\node.exe

前后SHA256：58e74bf02fc5bbacc41dcb8bef089961cd5bddd37830b87784e4fc624d145d1f

完整Node内部版本、where结果和PATH相关条目见runtime-before.json/runtime-after.json；MSI日志仅保留带原始行号的安装结论节选，完整日志仍在系统临时目录，路径和退出码见installation.json。

## 依赖改动与范围核验

| 依赖 | 原声明 | 新声明 | 原锁定 | 新锁定 |
| --- | --- | --- | --- | --- |
| @types/node | ^24.12.2 | ^24.19.2 | 24.12.4 | 24.19.2 |
| @tsconfig/node24 | ^24.0.4 | ^24.0.6 | 24.0.4 | 24.0.6 |
| undici-types（必要传递依赖） | @types/node原传递范围 | >=7.24.0 <7.24.7 | 7.16.0 | 7.24.6 |

实际更新命令：pnpm add --save-dev @types/node@^24.19.2 @tsconfig/node24@^24.0.6 --ignore-scripts --reporter=append-only --registry=https://registry.npmjs.org。没有执行依赖生命周期脚本，没有修改持久registry配置。

undici-types是新@types/node显式要求的依赖，原7.16.0不满足新范围，故属于本次必要变化。Vue 3.5.35、Vite 8.0.16、Pinia 3.0.4及其他包版本均保持不变；锁文件里Vite/Router/插件的同行变动是Node类型的peer引用更新，不是这些库升级。

范围核验：解析更新前后YAML，剔除两项指定包和必要undici记录，将Node类型peer键及对应optionalDependencies引用归一化后，其余结构逐项相等；manifest移除两项允许声明后完全相等；安装到node_modules的两项目标版本与锁一致，包数409→409。证明见dependency-scope.json和完整dependency-diff.txt。H5 engines仍为^20.19.0 || >=22.12.0。

server @types/node声明保持^24.0.0、锁定24.19.2，manifest与package-lock原始字节SHA256均未变；当前锁定已经是本次查到的24系最新版，建议本次保持不动，无需另行同步。

## 检查结果与阶段0比较

命令工作目录：server-check/server-test/server-random在D:/hdm-mall/server；client两项在仓库根；h5-type-check在D:/hdm-mall/shoph5-vue3。表内npm.cmd/pnpm.cmd为Windows实际启动程序，与npm/pnpm脚本命令等价。

| 检查 | 实际命令 | 阶段0发现数/结果 | 本次发现数 | 通过 | 失败 | 跳过 | seed | 退出码 | 秒 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| server-check | npm.cmd run check | 命令成功 | 不适用 | 命令成功 | 不适用 | 不适用 | 未设置 | 0 | 15.075 |
| server-test | npm.cmd test | 362 | 362 | 362 | 0 | 0 | 未设置 | 0 | 51.995 |
| server-random | node --test --test-randomize --test-random-seed=271113 test/*.test.ts | 362 | 362 | 362 | 0 | 0 | 271113 | 0 | 37.731 |
| client-test | node --test scripts/tests/*.test.mjs | 617 | 617 | 617 | 0 | 0 | 未设置 | 0 | 16.437 |
| client-random | node --test --test-randomize --test-random-seed=271113 scripts/tests/*.test.mjs | 617 | 617 | 617 | 0 | 0 | 271113 | 0 | 15.52 |
| h5-type-check | pnpm.cmd run type-check | 阶段0未执行 | 不适用 | 命令成功 | 不适用 | 不适用 | 未设置 | 0 | 25.714 |
| Hvigor模块测试 | 本次按范围不执行 | 83/83 | 未运行 | 不适用 | 不适用 | 不适用 | 不适用 | 不适用 | 不适用 |
| 签名构建 | 本次按范围不执行 | 退出码0 | 未运行 | 不适用 | 不适用 | 不适用 | 不适用 | 不适用 | 不适用 |

全部测试均零取消、零todo；两次随机顺序均在输出中实际打印seed 271113。server和客户端发现数量均与基线一致，无新增或消失用例。H5类型检查在阶段0未单独执行，本次只报告新结果，不虚构前后性能或通过率改善；墙钟时间受本机负载影响，不是性能基准。

## 10.7单独确认

Node直接执行.ts：server/package.json的test脚本仍为node --test test/*.test.ts；本次npm test日志实际打印该命令，362项通过，随机测试也直接执行同一批.ts，无构建、转换步骤或新loader参数。

SQLite 3.54.1备份恢复：backup.test.ts核心8项在常规与随机两轮均通过：

1. 在线 WAL 快照与头像恢复后，订单库存亲友一致，旧会话失效且可重新登录。
2. 无头像时上传目录可不存在，未引用的旧图片不进入快照。
3. 源路径拼错不创建数据库，头像和库存不一致仍生成快照并需显式允许恢复。
4. 已有目标、源目录内目标均被拒绝，不覆盖现有文件。
5. 哈希损坏、漏图、路径穿越和额外 WAL 均阻止恢复。
6. 清单哈希匹配仍检查数据库版本、外键和头像引用，链接不能作为上传目录。
7. 命令行完成创建、校验和恢复；失败退出非零且不回显凭证。
8. 命令行保存不一致快照后非零退出，显式参数允许恢复且不能绕过哈希校验。

另有旧版本manifest恢复、头像迁移、商品图片、库存、订单取消、支付退款、售后、对账与物流、服务记录、分类迁移及定时备份等关联项；本轮共51个具名关联测试均在两轮通过，完整名称和逐项结果见sqlite-tests.md/sqlite-tests.json，不用总通过数替代具名核验。

## 失败、修正与限制

首次pnpm更新因现有持久registry为https://repo.harmonyos.com/npm/，请求@vue/eslint-config-typescript元数据得到404，退出码1；当时git diff为空。保留pnpm-update.txt。定位后仅在本次命令传入npm官方registry，同一目标更新退出码0，日志为pnpm-update-official.txt；未升级额外依赖、改业务代码或放宽测试。

临时采集脚本在执行项目检查前有两处兼容性错误：git默认把中文路径转义，改为只对该只读命令使用core.quotepath=false；PowerShell读取含空包键的package-lock需ConvertFrom-Json -AsHashtable，已修正。首次锁范围核验漏归一化Vite的optionalDependencies中Node类型数值引用，因该项输出断言失败；补齐同一已授权类型引用的归一化后通过，未为此改锁文件或项目代码。这些是采集/核验脚本问题，不计作项目用例失败，也没有隐去首次pnpm的真实失败。

本次没有生产部署、真实支付/物流或设备验收；未运行H5 build:mobile、Hvigor与签名构建，不能据此宣称构建产物或鸿蒙运行重新通过。未执行git add/commit/push/stash/reset/checkout/clean；正式审核与提交交原Claude会话完成。

## 最终范围与证据索引

842份原跟踪文件逐字节SHA256复核，只有允许的两份依赖文件变化，其余840份一致，跟踪路径集合不变；未跟踪文件全部位于本证据目录，证明见verification.json。

最终git status：

```text
## mall-crazy-design-20261116
 M shoph5-vue3/package.json
 M shoph5-vue3/pnpm-lock.yaml
?? docs/refactor-evidence/stage1a-u1/
```

版本/安装：version-query.json、installer-verification.json、installation.json、runtime-before/after.json、msi-install.txt；依赖：dependencies-before.json、dependency-scope.json、dependency-diff.txt及两份pnpm日志；检查：checks.json、每项同名JSON/TXT；SQLite：sqlite-tests.md/json；收尾：verification.json、git-status.txt、file-manifest.json（不含自身）。本目录全部日志小于200KB，无投递回执文件。
