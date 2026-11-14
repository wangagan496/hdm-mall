# E 包隔离性能测量与优化复测

本目录只使用 Node 内置模块和本仓库已有服务端模块，没有新增 package.json 依赖。下方原流程是 schema17 的历史测量，末节为主仓库 schema18→19 的优化复测；两者基线和结论不可混用。

适用基线为提交 52b57aa9fde357babf7ebdcc66eb51421bc249ca、分离 HEAD；脚本会拒绝其他提交。后续 D 包合并后应在新的授权范围内更新基线并复测。

在 D:/hdm-mall-perf 执行：

```text
node scripts/perf/run.mjs --smoke
node scripts/perf/run.mjs
node scripts/perf/audit-callers.mjs
node scripts/perf/check.mjs
node scripts/perf/report.mjs
node scripts/perf/verify.mjs
```

运行前需要 Node 24 和 server/package-lock.json 已锁定的依赖；本次用 npm ci --offline --ignore-scripts --no-audit --no-fund 从本机缓存还原现有依赖，没有改变依赖声明与锁文件，也没有下载新依赖或执行安装脚本；check.mjs 在客户端测试需要时，核对两份既有锁文件的 TypeScript 6.0.3 版本后临时链接已还原的包，结束后移除链接，不安装 H5 依赖。

run.mjs 会生成独立临时目录，建立 500 名买家、1 名商家、200 商品、400 SKU、2 万历史订单、4 万订单明细和配套支付/评价/库存流水；随机合成密码与会话只保存在内存和随后删除的临时目录，不进入命令行与报告。

服务由单独 Node 子进程运行原 buildApp，监听系统分配的回环端口并拒绝 3103；数据库、上传目录均在临时目录。通过现有 trustedProxies 选项只信任回环地址，用 500 个合成客户端 IP 保留真实限流规则。先验证登录 20 次/分钟和通用 180 次/分钟的限流，再做开放式定速请求，分别记录发送后延迟、计划到达后延迟与调度迟延；并发积压上限 200，超出会记为客户端拒绝，不会静默降速或自动重试。

正式轮每个主要场景 60 秒；登录、搜索、下单、买家订单各 20 请求/秒；商家与亲友订单各 2 请求/秒；亲友峰值补充场景 20 请求/秒、30 秒；混合负载总计 20 请求/秒、60 秒。混合比例为登录 10%、搜索 40%、下单 20%、买家订单 20%、商家订单 5%、亲友订单 5%。商家始终使用同一 IP，故单独按 2 请求/秒测量以遵守原有限流。

每轮库存竞争以 40 个并发请求抢同一 SKU 的 10 件库存，正式执行 10 轮，核对 10 笔成功、30 次预期缺货、库存归零、订单与预占流水各 10 笔，以及成功请求重放不重复落单。

HTTP 服务关闭后，analyze.mjs 单独记录密码计算、真实业务方法与 SQL 的耗时和查询计划；候选索引只在临时数据库事务内创建、测量并回滚。分类增长与单用户深页偏斜均是补充敏感性实验，不冒充基线规模。数据库最后仍为迁移 017。

输出在 docs/step29-runs/<轮次>/，result.json 是汇总，各场景 JSON 保存不含凭据的逐请求数据，analysis.json 保存微基准与 EXPLAIN QUERY PLAN，cleanup.json 记录删除与端口重新绑定验证，server.log 只保留服务原有的请求元数据日志。正式报告以 docs/性能与规模评估.md 为准。

report.mjs 从逐请求样本重算发布口径，并写 derived-summary.json：未实际发送的限并发拒绝只计错误率，不作为零毫秒响应，也不计入收到响应的吞吐；本次正式轮的原始汇总未覆盖更新，原始记录完整保留供复核。收益预测和临时索引实验均不代表业务优化已经落地。

正常结束及捕获的失败都会停止自身服务、删除自身临时目录并重新绑定原端口确认释放；异常终止父进程时子服务会通过 IPC disconnect 自动关闭，但临时目录仍应按 active-run.json 核对后人工清理。脚本不会操作其他服务、设备、工作树、主仓库或 Git 写命令。

这些数据包含 HTTP 和服务端组装开销，不包含手机页面渲染、真实网络、TLS、代理、支付/物流外部系统、退款与售后大量积压、云端磁盘或生产长时间运行。

## D 包合并后的两路径优化复测

在 `D:/hdm-mall` 的 `mall` 分支、基线 `7a92a46` 上使用：

```text
node scripts/perf/run.mjs --optimize-before
node scripts/perf/run.mjs --optimize-after
node scripts/perf/compare-optimization.mjs
```

`--optimize-before` 必须在实际优化前的 schema18、尚未复用计数的源码状态运行；它不会自动回退源码。`--optimize-after` 使用已落地迁移019和分组计数复用的源码。脚本核对基线、分支、schema与计数次数；不要在当前优化后代码直接运行before，也不要为了测量执行Git回退写命令。两轮都保留开始时源码字节清单，并断言测量期间受控文件不变。

两种模式沿用原造数器和独立HTTP服务，只测亲友订单2请求/秒、60秒；随后 `optimization.mjs` 在服务关闭后测200/1000/2000商品的分类摘要，各预热2次、采样20次，增量数据事务回滚。没有新增全场景、亲友20请求/秒或手机渲染结论；不得与构建、全量测试或设备验收同时运行本任务的性能测量。

输出目录为 `docs/step29-runs/optimize-before-<时间>` 和 `optimize-after-<时间>`，包含逐请求样本、微基准原始耗时、EXPLAIN、源码清单及清理结果。`compare-optimization.mjs` 要求当前各一轮成功结果，重算p95并核对数据量、摘要哈希、分组计数、计数查询5→4、临时目录与端口清理，生成 `optimization-comparison.json`。重复测量须明确保留哪些轮次参与比较，不能挑选最快结果替代失败或慢样本。

原 `D:/hdm-mall-perf` 脚本与证据保持不变；历史报告生成器仍针对旧基线，不要用 `report.mjs` 覆盖主报告末尾的本次复测。此次源码检查、构建和设备结果统一记录在主仓库 `_device_acceptance/step29-runs`。
