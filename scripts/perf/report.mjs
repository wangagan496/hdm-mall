import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { root,output,stats,writeJson } from './common.mjs';

const selected=process.argv[2]??readdirSync(output).filter(p=>p.startsWith('formal-')).sort().at(-1);
const folder=resolve(output,selected),r=JSON.parse(readFileSync(join(folder,'result.json'),'utf8'));
assert.equal(r.status,'measured');assert.equal(r.smoke,false);
const a=JSON.parse(readFileSync(join(folder,'analysis.json'),'utf8'));
const audit=JSON.parse(readFileSync(join(output,'callers.json'),'utf8'));
const checks=JSON.parse(readFileSync(join(output,'checks.json'),'utf8'));
// Recompute published quantiles from retained raw samples. An unsent admission refusal
// contributes to the error rate, never a fictitious zero-millisecond HTTP response.
for(const s of r.scenarios){
  const raw=JSON.parse(readFileSync(join(folder,s.name+'.json'),'utf8')).samples;
  const sent=raw.filter(x=>!x.clientShed);
  s.dispatched=sent.length;s.clientShed=raw.length-sent.length;
  s.transportFailures=sent.filter(x=>x.status===0).length;
  s.latencyMs=stats(sent.map(x=>x.elapsedMs));s.scheduledLatencyMs=stats(sent.map(x=>x.scheduledMs));s.schedulerLagMs=stats(sent.map(x=>x.lagMs));
  s.completedRps=sent.filter(x=>x.status>0).length/(s.elapsedMs/1000);
}
writeJson(join(folder,'derived-summary.json'),{method:'Recomputed from raw per-request samples; exclude unsent client admissions from latency and received-response throughput; retain all planned requests in error denominator',scenarios:r.scenarios});
const f=v=>Number(v).toFixed(2),pct=v=>(v*100).toFixed(2)+'%',kb=v=>(v/1024).toFixed(1),mb=v=>(v/1048576).toFixed(2);
const date=s=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'medium',timeStyle:'medium',hour12:false}).format(new Date(s));
const names={login:'登录',search:'商品搜索',create:'下单',orders:'买家订单分页',merchant:'商家订单分页',family:'亲友订单分页','family-peak':'亲友订单集中峰值',mixed:'混合流量'};
const get=n=>r.scenarios.find(s=>s.name===n),op=n=>a.operations[n],ex=n=>a.indexExperiments.find(s=>s.name===n),q=n=>a.queries.find(s=>s.name===n);
const gate=s=>s.successLatencyMs.p95<=500&&s.successLatencyMs.p99<=1000&&s.errorRate<.01;
const mainPass=['login','search','create','orders','mixed'].every(n=>gate(get(n)));
const ordinaryOrders=op('buyer-page-1'),merchantArray=op('legacy-merchant-array');
const text=`# 性能与规模评估

测量日期：${date(r.startedAt)} 至 ${date(r.finishedAt)}，北京时间。

任务：${r.taskId}。测量基线：52b57aa9fde357babf7ebdcc66eb51421bc249ca，分离 HEAD。执行目录：D:/hdm-mall-perf。

## 结论

${mainPass?'在本机、当前数据分布和本报告的混合流量下，SQLite 足以支撑建议规模，主要路径符合本报告提出的暂定耗时目标。':'当前实测未全部达到本报告提出的暂定耗时目标，应先处理失败场景，再判断建议规模是否达标。'}混合 20 请求/秒共 ${get('mixed').requests} 次请求，p50/p95/p99 为 ${f(get('mixed').latencyMs.p50)}/${f(get('mixed').latencyMs.p95)}/${f(get('mixed').latencyMs.p99)} 毫秒，异常错误率 ${pct(get('mixed').errorRate)}。

${gate(get('family-peak'))?'亲友订单集中 20 请求/秒的补充场景也达到暂定目标，但其扫描和重复计数仍是扩容时最需要关注的路径。':'亲友订单集中 20 请求/秒没有达到暂定耗时目标：该场景 p95 为 '+f(get('family-peak').latencyMs.p95)+' 毫秒、p99 为 '+f(get('family-peak').latencyMs.p99)+' 毫秒，存在排队，不能把“混合 20 请求/秒可用”扩大成“任意接口均可持续 20 请求/秒”。'}数据库迁移、业务代码均未修改；本次结论不包含生产服务器、真实网络、目标手机或 D 包合并后的性能。

## 建议规模与验收口径

建议规模：单个小商家、首批 500 名买家、200 件商品、2 万笔历史订单、峰值每秒 20 次请求，主要设备 Pura 系列；全部待用户确认。本次另设 1 个商家账号，所以 users 表为 501 行。

建议的暂定目标为正常请求 p95 不超过 500 毫秒、p99 不超过 1,000 毫秒、非预期错误率低于 1%，也待用户确认，并非已有服务承诺。第 170 行保持未勾选；第 121 行只完成评估，没有退役接口或应用索引；第 171、172 行不在本次测量授权下修改状态，仍应由主导方在规模确认、瓶颈处理及 D 包合并后复测验收。

## 环境、数据与方法

- Node ${r.environment.node}，SQLite ${r.environment.sqlite}，${r.environment.platform} ${r.environment.release}；CPU 为 ${r.environment.cpu}，${r.environment.logicalCpus} 个逻辑处理器，内存 ${f(r.environment.totalMemoryBytes/1073741824)} GiB。
- 本机共享 Windows 环境，用户的其他桌面工作和 D 包任务可能并行，未取得独占 CPU/磁盘；测试发生在同一台主机，结果不能直接视为云服务器容量。使用文件数据库、原有 WAL、原有同步 DatabaseSync 路径，未改 PRAGMA 配置。
- 初始数据为 501 用户、200 商品、400 SKU、20,000 历史订单、40,000 明细、16,000 成功支付、12,000 评价、210 分类（10 一级、200 二级）、500 亲友关系和 48,400 库存流水；初始数据库 ${mb(r.dataset.databaseBytes)} MiB。
- 历史订单按用户均匀分布，每人 40 笔，状态分布为完成 12,000、取消 4,000、待收货 2,000、待发货 2,000；部分支付由绑定亲友完成。商品预置较充足的库存。没有退款、售后或支付异常积压，没有真实上传图片；这类重负载需另补场景。
- HTTP 测量会生成新订单，最后订单总数为 ${r.finalDatabase.counts.orders}；后续微基准沿用这份临时库，因此是“2 万历史订单加本轮新订单”，不是重置后的恰好 2 万行。
- 服务使用现有 buildApp，独立 Node 子进程、logger 开启、原有鉴权/限流/30 秒定时任务开启；只监听回环地址、系统分配端口，不使用 3103。压测器使用真实 HTTP keep-alive，没有 app.inject 代替网络测量。
- 用现有 trustedProxies 选项仅信任回环代理，X-Forwarded-For 模拟 500 个买家 IP；未关闭或放大限流。实测同一 IP 登录 25 次得到 20 个 200、5 个 429，通用接口 185 次得到 180 个 200、5 个 429。商家始终使用同一 IP，以 2 请求/秒测量；本场景不同于把全部买家误识别为一个代理 IP 的部署。
- 开放式定速发起请求，每个主要场景 60 秒；亲友集中峰值 30 秒。每场景先预热 10 次，不计入表中样本。超时为 15 秒，客户端最多 200 个在途请求，超限显式记录为错误；不自动重试、不以完成上次请求作为发起下次的条件。
- 混合场景总计 20 请求/秒：登录 10%、搜索 40%、下单 20%、买家订单 20%、商家订单 5%、亲友订单 5%。下单使用立即购买、一个 SKU、一件商品；没有测支付、发货或物流。
- 分位数使用最近秩法；延迟从客户端发送前计时，直到完整读取响应并 JSON.parse 完成；另保存从计划发起时刻开始的延迟，避免只报快速请求。每个正式场景只做一轮，没有跨主机或跨时间的置信区间；小样本微基准的 p99 尤其不能外推。

## HTTP 正式实测

单位：毫秒。错误率包含超时、传输错误、非预期非 200 响应、返回结构校验失败与客户端限并发拒绝。报告分位数从原始逐请求记录重新计算，未发出的请求只计失败率，不当作 0 毫秒响应；统一结果见 derived-summary.json。

| 场景 | 请求/秒 | 计划 / 发出次数 | p50 | p95 | p99 | 错误率 | 暂定目标 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
${r.scenarios.map(s=>`| ${names[s.name]} | ${s.offeredRps} | ${s.requests} / ${s.dispatched} | ${f(s.latencyMs.p50)} | ${f(s.latencyMs.p95)} | ${f(s.latencyMs.p99)} | ${pct(s.errorRate)} | ${gate(s)?'达到':'未达到'} |`).join('\n')}

| 场景 | 含发起调度迟延 p99 | 调度迟延 p99 | 最大在途数 | 实际完成请求/秒 | 服务事件循环迟延 p99 |
| --- | ---: | ---: | ---: | ---: | ---: |
${r.scenarios.map(s=>`| ${names[s.name]} | ${f(s.scheduledLatencyMs.p99)} | ${f(s.schedulerLagMs.p99)} | ${s.maxInFlight} | ${f(s.completedRps)} | ${f(s.server.eventLoopMs.p99)} |`).join('\n')}

实际完成请求/秒只计收到 HTTP 响应的次数，包含尾部排空时间，计划到达与响应吞吐不能互换。亲友集中峰值共 ${get('family-peak').unexpectedErrors} 次未成功，其中 ${get('family-peak').clientShed} 次在客户端达到并发上限后拒绝，${get('family-peak').transportFailures} 次已发送请求在约 15 秒超时边界未收到有效响应；这是实测未达标，不能用较快的成功子集掩盖。每个场景的逐请求状态码、原始耗时、返回字节数、JSON 解析耗时，以及服务端 CPU/RSS 快照保存在同名 JSON。

## 同一 SKU 库存竞争

${r.inventory.rounds.length} 轮，每轮 40 个并发请求争抢 10 件库存，共 ${r.inventory.requests} 次请求；成功 ${r.inventory.rounds.reduce((s,v)=>s+v.successes,0)} 次、预期缺货 409 共 ${r.inventory.expectedBusinessRejections} 次，非预期错误 ${r.inventory.unexpectedErrors} 次。整体 p50/p95/p99 为 ${f(r.inventory.latencyMs.p50)}/${f(r.inventory.latencyMs.p95)}/${f(r.inventory.latencyMs.p99)} 毫秒。

每轮核实库存归零、10 个不同订单、10 条预占流水；重放一笔已成功请求仍返回原订单，库存、订单数和流水数均不再变化。原始非 2xx 比例为 ${pct(r.inventory.rawNon2xxRate)}，这是已核实的缺货业务拒绝，不能藏在“零错误”里，也不能当成 75% 系统故障。本次未观察到超卖；它验证的是单个服务进程和 SQLite 事务路径，没有验证多实例部署。

## 密码计算、数据库查询与订单列表加载

密码路径使用源码相同的 scryptSync 参数，没有降低密码强度。这些微基准在 HTTP 服务关闭后单独运行，与登录 HTTP 不同时间采样；调度和主机负载可能不同，因此不能将各自分位数相加，或视为同一个登录请求的直接分段。

| 项目 | 样本数 | p50 | p95 | p99 |
| --- | ---: | ---: | ---: | ---: |
${Object.entries(a.password).map(([k,v])=>`| ${k} | ${v.milliseconds.n} | ${f(v.milliseconds.p50)} | ${f(v.milliseconds.p95)} | ${f(v.milliseconds.p99)} |`).join('\n')}

下面是同机服务内业务方法完成数据查询、权限/状态整理后的耗时，不含 HTTP；SQL 调用数是另一次单次采样，随订单状态、到期检查而变化，不能当作每个请求恒定值。

| 业务方法 | 样本数 | p50 | p95 | p99 | 单次 SQL 调用数 | 返回 KiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${Object.entries(a.operations).map(([name,v])=>`| ${name} | ${v.milliseconds.n} | ${f(v.milliseconds.p50)} | ${f(v.milliseconds.p95)} | ${f(v.milliseconds.p99)} | ${v.queryCalls} | ${kb(v.payloadBytes)} |`).join('\n')}

订单列表加载口径：买家分页 HTTP p95 ${f(get('orders').latencyMs.p95)} 毫秒，包含完整响应读取及 JSON 解析；服务内首批 10 条组装 p95 ${f(ordinaryOrders.milliseconds.p95)} 毫秒、约 ${kb(ordinaryOrders.payloadBytes)} KiB。没有操作设备，因此未测 ArkUI 渲染、首屏完成、图片下载或滚动流畅度，不把服务端列表耗时写成手机页面耗时。

| 主要 SQL | 样本数 | p50 | p95 | p99 |
| --- | ---: | ---: | ---: | ---: |
${a.queries.map(v=>`| ${v.name} | ${v.milliseconds.n} | ${f(v.milliseconds.p50)} | ${f(v.milliseconds.p95)} | ${f(v.milliseconds.p99)} |`).join('\n')}

## 第 121 行：旧数组接口是否还有调用方

静态扫描覆盖 ${audit.scannedFiles} 个受版本控制的源码和脚本文件，完整命中含行号保存在 callers.json。接口仍注册并不等于仍被正式页面调用；同路径 POST 是写接口，不能算成 GET 数组的消费者。

| GET 数组接口 | 当前仓库证据 | 结论 |
| --- | --- | --- |
| /home/category/head、/category/top | 原生首页和分类改用 /category/summary；/category/top 仍被服务端兼容测试调用 | 当前应用页面未发现调用；保留兼容测试，不能证明已安装旧客户端不调用 |
| /home/new | 当前 getHomeNewAPI 使用 /home/new/page，每页 8 件；旧路径仍有服务端测试 | 当前应用页面未发现旧路径调用 |
| /home/recommend | home.ets 的 getRecommendAPI 包装仍在，但符号只命中定义；HomeView 和 homePrefetch 调用 getRecommendPageAPI | 旧包装未发现页面调用，可先标弃用，不直接删服务端接口 |
| /member/relations | cart.ets、family.ets 留有旧包装与导出，getFamilyRelationsForSessionAPI 还由 scripts/tests/family-pagination.test.mjs 调用；PayView、FamilyView 使用分页 | 仍有测试消费者；旧包装保留，未发现当前页面直接调用 |
| /member/family-orders | family.ets 旧包装没有页面引用；scripts/device-trade-regression.ps1 第 363、441 行仍真实调用数组接口，服务端测试也调用 | 仍有明确脚本调用方，不能直接退役 |
| /merchant/orders | family.ets 旧包装没有页面引用；服务端支付、订单权限测试仍调用；FamilyView 使用 /merchant/orders/page | 仍有测试调用方，不能直接退役 |

H5 子项目当前是资料编辑范围，扫描未发现上述数组 URL。以上不能覆盖动态拼接 URL、外部调用或已安装旧包；退役前应先迁移仓库内消费者、补调用量与客户端版本证据，再安排兼容窗口，本次不删除接口。

旧商家数组在 2,000 笔待发货订单下，单次返回 ${mb(merchantArray.payloadBytes)} MiB、采样 ${merchantArray.queryCalls} 次 SQL，${merchantArray.milliseconds.n} 次微基准 p95 ${f(merchantArray.milliseconds.p95)} 毫秒；分页返回十条的 p95 ${f(op('merchant-page-1').milliseconds.p95)} 毫秒。大数组仍能造成明显单请求阻塞，不能因为当前页面分页就忽略兼容入口。

## 分类名称规模增长

Products.create 与 Catalog.seed 为每个商品建立二级分类，因此当前设计中分类名数量大体随商品数增长；“只返回名称和封面”不等于固定开销。补充实验保持 10 个一级分类，商品/二级分类从 200 扩到 1,000 和 2,000，只在临时事务内生成、测完回滚。

| 商品数 | 分类行数 | 摘要 p95 | 摘要加候选索引 p95 | 旧分类数组 p95 | 摘要 KiB |
| --- | ---: | ---: | ---: | ---: | ---: |
${a.categoryGrowth.map(g=>`| ${g.products} | ${g.categoryRows} | ${f(g.summary.milliseconds.p95)} | ${f(g.summaryWithCandidateIndexes.milliseconds.p95)} | ${f(g.legacy.milliseconds.p95)} | ${kb(g.payloadBytes)} |`).join('\n')}

分类摘要原始 EXPLAIN 可见外层 SCAN c、相关子查询及商品候选扫描；候选索引是 skus(product_id,enabled,stock,price) 和 categories(parent_id)。组合索引后，内部计划改走 MULTI-INDEX OR、product_categories_category 和 SKU 覆盖索引，2,000 商品的摘要 p95 由 ${f(a.categoryGrowth.at(-1).summary.milliseconds.p95)} 降到 ${f(a.categoryGrowth.at(-1).summaryWithCandidateIndexes.milliseconds.p95)} 毫秒；完整结果做过相等校验。这是组合候选在临时库中的局部实测，未单独拆分两者贡献，也未测新增索引后的写入成本。后续优先验证这组候选，若继续扩张仍不够，再评估集合式封面查询、缓存失效或逐级加载分类名称。

## 索引和 EXPLAIN QUERY PLAN

以下索引只在临时数据库事务中创建并回滚，没有迁移文件，也没有写入业务库；每项都验证查询结果相同。耗时是该条 SQL 的微基准，不是接口优化后的成绩。

| 候选索引 | 原计划要点 | 候选计划要点 | 原 SQL p95 | 临时索引后 p95 |
| --- | --- | --- | ---: | ---: |
${a.indexExperiments.map(v=>`| ${v.ddl.replace('CREATE INDEX ','')} | ${v.before.plan.map(p=>p.detail).join('；')} | ${v.after.plan.map(p=>p.detail).join('；')} | ${f(v.before.milliseconds.p95)} | ${f(v.after.milliseconds.p95)} |`).join('\n')}

优先考虑 orders(state,created,id)，它直接替代商家待发货查询的临时排序；orders(owner_id,created DESC,id) 能消除买家同时间排序的尾部临时排序，但普通用户只有几十笔订单时收益很小。skus 的 product_id 前缀可覆盖商品详情和分类可售判断；categories(parent_id) 对独立子分类检索有用，却不代表摘要总耗时必然下降；sessions(expires) 对登录的过期会话扫描有帮助，当前容量下仍远小于密码计算。应评估写入成本和磁盘增量后再落迁移，不能将五个候选全部直接加入。

亲友分页按 group=all 返回时，为 pay、receipt、pending、all 分别计数，再在取页路径重复计算 all；实测 trace 中同一 all 计数执行两次，pending/all 及取页可见 SCAN o 和相关支付/关系查询。单独加 orders 的排序索引不能消掉这些权限筛选，需在保留付款人、绑定状态、代收权限和撤销边界的前提下复用计数、调整查询结构；若改从 payer_id 等入口取候选，再测相应复合索引，不能在当前 SQL 未命中前宣称有效。

## 深页查询

基线每个买家有 40 笔历史订单，只测第 1—4 页；商家待发货 2,000 笔，HTTP 交替测第 1 和第 200 页。超出数据总数的空页不能代表深页成本。

另做偏斜敏感性实验：临时把 10,000 笔历史订单归到同一合成买家名下，并在事务结束回滚；这不是建议规模的默认用户分布。

| OFFSET | 原查询 p50 | 原查询 p95 | 原查询 p99 |
| ---: | ---: | ---: | ---: |
${a.deepPage.offsetBaseline.map(v=>`| ${v.offset} | ${f(v.milliseconds.p50)} | ${f(v.milliseconds.p95)} | ${f(v.milliseconds.p99)} |`).join('\n')}

OFFSET 9,990 在复合索引后的 p95 为 ${f(a.deepPage.indexedOffset.milliseconds.p95)} 毫秒；同一锚点的游标查询 p95 为 ${f(a.deepPage.keyset.milliseconds.p95)} 毫秒，结果逐项相等，计划为 ${a.deepPage.keysetPlan.map(p=>p.detail).join('；')}。游标须同时保存 created 和 id，并保持 created 降序、id 升序及筛选条件，不能只用时间戳；跳转任意页、计数和并发插入语义仍需产品与回归验证。本次没有替换分页协议。

## 瓶颈、优化建议与预计收益

下列收益分为已经测到的局部差异与尚未落地的端到端预测；没有把预测写成已完成优化。

1. 亲友订单优先处理重复计数与整表权限扫描。单次可读计数实测均值 ${f(q('family-readable-count').milliseconds.mean)} 毫秒；仅复用已算出的 all 计数，理论上每次 group=all 请求可省去接近一次该计数的成本，数量级为 ${f(q('family-readable-count').milliseconds.mean)} 毫秒，但完整接口收益尚未实测。进一步查询改写的目标是使集中峰值达到 p95 500 毫秒以内，不承诺尚未测得的倍数。
2. 商家排序复合索引。对应深页 SQL 的 p95 在临时实验中由 ${f(ex('merchant-order-index').before.milliseconds.p95)} 降到 ${f(ex('merchant-order-index').after.milliseconds.p95)} 毫秒；预计接口只节省该 SQL 的一部分，不能把 SQL 倍率直接套到整个页面。当前十条列表仍有 ${op('merchant-page-1').queryCalls} 次 SQL 采样，后续批量读取明细/支付/售后资料才可能明显降低组装开销，需保持权限和状态一致。
3. 密码计算保持现有强度，评估异步或有限工作线程池。同步 scrypt 实测 p95 ${f(a.password.scryptSync64.milliseconds.p95)} 毫秒，预测收益是避免主事件循环连续阻塞约一次哈希耗时，不是降低哈希本身的计算量；并发上限、排队与内存开销仍要复测。
4. 分类摘要优先复核组合索引的局部收益。2,000 商品时临时实验 p95 ${f(a.categoryGrowth.at(-1).summary.milliseconds.p95)}→${f(a.categoryGrowth.at(-1).summaryWithCandidateIndexes.milliseconds.p95)} 毫秒，足以将其列为明确候选；预计分类接口可减少接近一次摘要查询的成本，但 HTTP 并发、写入开销和实际 D 包基线尚未复测。缓存属于下一步备选，不在没有命中率证据时承诺收益。
5. 深页按需升级。普通买家 40 笔记录暂无强制改游标的必要；偏斜到 10,000 笔时，游标和复合索引的局部 SQL 改善已实测，接口预测收益只覆盖取页 SQL，不包含总数查询和订单状态组装。
6. 旧数组入口先迁移确定的脚本/测试消费者并取得旧包调用证据，避免大响应占据单进程。普通页面已分页，不以删除旧接口作为本轮“完成优化”。

SQLite 在本次混合模型下够用，并不意味着数据库选型已经覆盖生产所有情形；当前主要风险来自应用层同步计算、亲友权限查询、逐订单附加查询和旧数组入口。没有证据要求本阶段直接迁移数据库；在业务规模确认、D 包合并、数据分布补齐后，优先复测上述路径，再依据真实部署决定是否扩容或迁移。

## 验证、清理和交付

- 正式计划请求 ${r.scenarios.reduce((s,v)=>s+v.requests,0)} 次，实际发出 ${r.scenarios.reduce((s,v)=>s+v.dispatched,0)} 次，另有库存竞争 ${r.inventory.requests} 次、${r.inventory.rounds.length} 次幂等重放和独立限流探针；预热与限流探针不混入正常请求错误率。
- 库存不为负、PRAGMA integrity_check 为 ok、foreign_key_check 为空；数据库版本始终为 17，临时候选索引均已回滚。
- 对比 ${r.integrity.trackedFilesCompared} 个原有受控文件的字节哈希，变动为 ${r.integrity.changedTrackedFiles.length}，HEAD 和分离状态保持不变；未修改业务、迁移、依赖声明或锁文件，未操作主仓库、设备或 Git 写命令。
- 本轮自身服务进程退出码 ${r.cleanup.serviceExit?.code}，临时根目录、SQLite/WAL/SHM、合成凭据及上传目录随根目录删除；原测量端口 ${r.cleanup.port} 已通过再次绑定确认释放，未使用 3103。
- 语法检查、服务端类型检查及直接相关回归测试${checks.passed?'全部通过':'存在失败，见 checks.json'}；实际执行列表与原始日志见 checks.json 和 checks/，没有声称执行全仓库、设备或构建验收。
- 第一次客户端回归因隔离副本缺少 H5 TypeScript 路径而未启动，失败日志保留在 checks/client-related.initial.log；随后核对两份既有锁文件均为 TypeScript 6.0.3，仅临时链接已还原的同版本包，完成 21 项客户端回归后移除链接及空父目录，没有安装 H5 依赖或改测试导入；服务端相关 36 项回归也全部通过，均为零跳过。
- 隔离副本不含 docs/执行须知.md；遵守不触碰主目录的约束，未去另一工作区读取或补写该文件，必要的新验证经验已写入本报告及 scripts/perf/README.md。
- 原始证据目录：${folder.replaceAll('\\','/')}；调用方证据：D:/hdm-mall-perf/docs/step29-runs/callers.json；最终执行证明：D:/hdm-mall-perf/docs/step29-runs/final-verification.json。
- 执行证明在正式回传前封版，投递回执在原生桥接发送后另写 delivery-receipt.json；传输写入成功不等于 Claude 模型已经读取或完成验收。

复测命令与边界见 D:/hdm-mall-perf/scripts/perf/README.md。待用户确认规模与流量结构、D 包合并、生产环境确定后，重新执行实测；本报告不修改建设目标勾选状态。
`;
assert.ok(!text.includes('**'));
const path=join(root,'docs/性能与规模评估.md');writeFileSync(path,text);
console.log(JSON.stringify({path,bytes:Buffer.byteLength(text),firstLines:text.split('\n').slice(0,3),formalRun:r.runId,mainPass,familyPeakPass:gate(get('family-peak'))}));
