# 惠多美重构阶段0：可比较基线

任务编号 stage0-20261117-01；采集日期 2026-11-17，时区 Asia/Shanghai。仅记录并运行已授权检查，未改业务代码或配置、未安装或升级依赖、未操作设备、未执行 Git 写操作。执行证据已封版，待原 Claude Desktop 会话独立复核；投递回执将在正式回传后单独生成。

## 结论

7条请求命令均以退出码0完成：服务端常规及固定随机种子各362项，客户端常规及固定随机种子各617项，Hvigor共83项通过，均无失败、无跳过；服务端类型检查和签名构建成功。Hvigor的12个模块报告中7个模块零用例，不能把这些模块的构建成功称作行为覆盖。

构建前后 Git 均仅显示新证据目录；16组、704个范围内跟踪文件的原始字节哈希以及清单配置哈希复核一致。签名包已更新，产物哈希见下表。现有H5 dist与原生rawfile字节哈希不同，逐字文本比较证实只存在CRLF/LF换行差异；本轮没有重编H5。

## 开工前核对与范围

| 项目 | 本次结果 |
| --- | --- |
| 仓库 | D:/hdm-mall |
| 分支 | mall-crazy-design-20261116 |
| HEAD | 282b006a03af38b986a6ef86c03bf5e05140eaca |
| 初始 git status | ## mall-crazy-design-20261116；无修改、无未跟踪文件 |
| 方案 SHA256 | 9aeed578cb4a511dfdc23ccfa2b8ebc39eee839da675580275869a722245718d |
| 阅读范围 | 方案“通用落点、完成标准与测试分工”“阶段0”；技术进化分析10.7 U0行；docs/执行须知.md全文 |
| 设备 | 未启动、安装、连接或操作模拟器；未使用 hdc |
| 许可产物写入 | 签名构建更新 build，模块测试产生 .test/.hvigor 中间文件；跟踪文件未变 |

## 版本声明、锁定版本与文件哈希

三种证据分开：declaration是manifest原声明，locked是锁文件解析值，sha256是该文件磁盘原始字节哈希；integrity是依赖包内容校验字段，不能代替锁文件SHA256。versions.json保存29条npm直接依赖、完整锁定包键/版本/integrity和13份原生清单的依赖、specifiers、packages；本轮未联网查询新版本。

| 文件 | SHA256 |
| --- | --- |
| server/package.json | b808a0606399e7ed3c5369d1f4dc296f877e84433777a71912179e40bb07cbc8 |
| server/package-lock.json | 18d9c02aaa0d9aaec3142b178a95ac672b59e8d231c1eaa3ae99ddba29989216 |
| shoph5-vue3/package.json | 5ec5324db59ec467f2000cf2644bd7eeef502b6492aa1588d7fd46533387be6d |
| shoph5-vue3/pnpm-lock.yaml | b65b986686813a0830cfeb925e2063d03748e39b7d6934c09fa3e5f7cf7306db |

### server

工程自身声明版本 0.1.0；锁文件格式版本 3。

| 包 | 类型 | 版本声明 | 锁定版本（主版本值） |
| --- | --- | --- | --- |
| @fastify/multipart | dependencies | ^10.1.6 | 10.1.6 |
| @fastify/rate-limit | dependencies | ^11.2.1 | 11.2.1 |
| fastify | dependencies | ^5.6.2 | 5.12.7 |
| zod | dependencies | ^4.1.12 | 4.6.7 |
| @types/node | devDependencies | ^24.0.0 | 24.19.2 |
| typescript | devDependencies | ~6.0.0 | 6.0.3 |

### shoph5-vue3

工程自身声明版本 0.0.0；锁文件格式版本 9.0。

| 包 | 类型 | 版本声明 | 锁定版本（主版本值） |
| --- | --- | --- | --- |
| axios | dependencies | ^1.17.0 | 1.17.0 |
| pinia | dependencies | ^3.0.4 | 3.0.4 |
| vant | dependencies | ^4.9.24 | 4.9.24 |
| vue | dependencies | ^3.5.32 | 3.5.35 |
| vue-router | dependencies | ^5.0.4 | 5.1.0 |
| @tsconfig/node24 | devDependencies | ^24.0.4 | 24.0.4 |
| @types/node | devDependencies | ^24.12.2 | 24.12.4 |
| @vitejs/plugin-vue | devDependencies | ^6.0.6 | 6.0.7 |
| @vue/eslint-config-typescript | devDependencies | ^14.7.0 | 14.7.0 |
| @vue/tsconfig | devDependencies | ^0.9.1 | 0.9.1 |
| eslint | devDependencies | ^10.2.1 | 10.4.1 |
| eslint-config-prettier | devDependencies | ^10.1.8 | 10.1.8 |
| eslint-plugin-oxlint | devDependencies | ~1.60.0 | 1.60.0 |
| eslint-plugin-vue | devDependencies | ~10.8.0 | 10.8.0 |
| jiti | devDependencies | ^2.6.1 | 2.7.0 |
| npm-run-all2 | devDependencies | ^8.0.4 | 8.0.4 |
| oxlint | devDependencies | ~1.60.0 | 1.60.0 |
| prettier | devDependencies | 3.8.3 | 3.8.3 |
| typescript | devDependencies | ~6.0.0 | 6.0.3 |
| vite | devDependencies | ^8.0.8 | 8.0.16 |
| vite-plugin-singlefile | devDependencies | ^2.3.3 | 2.3.3 |
| vite-plugin-vue-devtools | devDependencies | ^8.1.1 | 8.1.2 |
| vue-tsc | devDependencies | ^3.2.6 | 3.3.3 |

### 原生13份清单

N代表D:/hdm-mall/mixed-development-h5；扫描排除build、.test、oh_modules及工具缓存/依赖目录，确认根1、products/phone 1、features 4、commons 7。下表哈希为各目录oh-package.json5；各锁文件、build-profile.json5、hvigorfile.ts的完整路径和SHA256均在versions.json.native.modules[].files。

| N下目录 | 自身版本声明 | 锁文件 | manifest SHA256 |
| --- | --- | --- | --- |
| commons/constants | 1.0.0 | 不存在 | 54cec5aab64a9b2bcd242c8c5dd0b0482856a3dd78f15ec12177fad437980e57 |
| commons/device | 1.0.0 | 不存在 | a582c086cac3d16572b0de5038628de901aed81c51a3f42de476e912c97f2aa6 |
| commons/models | 1.0.0 | 存在 | 2b3c6901d7086583aff9e069684e3bbef4579536f716eb1a40a6228ef7da591c |
| commons/network | 1.0.0 | 存在 | 9c4e38a430cf76698a47912ae815ff2a53af2ffb17730213f3e5d8b5005a275b |
| commons/storage | 1.0.0 | 存在 | 19e46e422da2ba7f604611e1d6674ee0c0838f98d2ada786bfcb542c23cb617b |
| commons/ui-components | 1.0.0 | 存在 | 9d62f6562b5f2ef194092d67d983bc033f75bd4404c46b1dfd31907bdae523b8 |
| commons/utils | 1.0.0 | 存在 | ed7c3116ff6486dbd742b31924050ffb15c4ca7c6b7af3d3aa1ad61d411e8ca0 |
| features/cart | 1.0.0 | 存在 | 205820318df4e94d11bd7fe7a945e585cdeba2edad1fd313c11f4d126e26dc11 |
| features/category | 1.0.0 | 存在 | 8d93c787c94b014004bfb0b09be899f66ab4e55debf4d37929618ed3aa5f2bca |
| features/home | 1.0.0 | 存在 | 9cce4f66ab8f9563cdf26347f65b306095df345cbf4323afd5b41a41c0b59d16 |
| features/mine | 1.0.0 | 存在 | 60e618c33d2e794129b389a4efb92c3a4f39b59d4ea5c4d61f960febc0f9276b |
| . | 未声明 | 存在 | ed8aae4db61af1d758cc07f4f49d6ddad067bde4b31818b06aeb440d4ed388b7 |
| products/phone | 1.0.0 | 存在 | 2879fc34d08c0c09f13f75a0f23d2305b620d97db0ead48eb7987e4c9835a6e0 |

| 外部包声明所在位置 | 依赖 | 声明 | 锁定 |
| --- | --- | --- | --- |
| N根 devDependencies | @ohos/hypium | 1.0.25 | 1.0.25 |
| N根 devDependencies | @ohos/hamock | 1.0.0 | 1.0.0 |
| N/commons/network | @ohos/axios | ^2.2.4 | 2.2.4 |
| N/commons/ui-components | @ohmos/sku | ^1.0.1 | 1.0.1 |

内部@module依赖与实际相对路径锁定关系逐模块保存在versions.json；内部模块自身声明及锁文件版本为1.0.0。constants、device的锁文件不存在，两者无依赖声明，按现状记录，未生成锁文件。共13份build-profile、13份hvigorfile和根hvigor/hvigor-config.json5已记录哈希；hvigor modelVersion为6.0.2，不等于本机Hvigor运行包版本。native-configs.json保存安全配置内容；本机build-profile.local.json5仅记录存在性、大小与哈希，不复制签名内容。

## 机器运行时与工具链

| 工具 | 本次实测/本机元数据 | 来源 |
| --- | --- | --- |
| 系统Node | v24.16.0 | C:\xunlei\node-v24.16.0-win-x64\node-v24.16.0-win-x64\node.exe |
| npm | 11.13.0 | C:\xunlei\node-v24.16.0-win-x64\node-v24.16.0-win-x64\npm.cmd |
| pnpm | 11.9.0 | C:\xunlei\node-v24.16.0-win-x64\node-v24.16.0-win-x64\pnpm.cmd |
| DevEco Studio | 26.0.0.821 / build 261.23567.138.36.2600821 | C:/Program Files/Huawei/DevEco Studio |
| DevEco随附Node | v24.14.1 | C:/Program Files/Huawei/DevEco Studio/tools/node/node.exe |
| Hvigor及OHOS插件 | 6.26.4 / 6.26.4 | 安装根tools/hvigor/hvigor和hvigor-ohos-plugin/package.json |
| HarmonyOS SDK default | API 26；platformVersion 26.0.0；version 26.0.0.105 | C:\Program Files\Huawei\DevEco Studio\sdk |
| 项目目标/最低API | targetSdkVersion与compatibleSdkVersion均6.1.1(24) | N/build-profile.json5 |

DevEco Studio环境变量指向bin，执行模块测试时已去掉bin定位安装根，未误用项目内不存在的hvigorw。SDK安装版本、项目API声明和设备实际API是不同证据；本轮不核验设备。runtime.json保留元数据文件哈希。

## 本轮检查结果

| 检查 | 工作目录 | 实际命令 | 用例数 | 通过 | 失败 | 跳过 | seed | 退出码 | 墙钟耗时秒 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| server-check | D:/hdm-mall/server | npm run check | 不适用 | 命令成功 | 不适用 | 不适用 | 未设置 | 0 | 37.949 |
| server-test | D:/hdm-mall/server | npm test | 362 | 362 | 0 | 0 | 未设置 | 0 | 55.696 |
| server-random | D:/hdm-mall/server | node --test --test-randomize --test-random-seed=271113 test/*.test.ts | 362 | 362 | 0 | 0 | 271113 | 0 | 40.385 |
| client-test | D:/hdm-mall | node --test scripts/tests/*.test.mjs | 617 | 617 | 0 | 0 | 未设置 | 0 | 15.85 |
| client-random | D:/hdm-mall | node --test --test-randomize --test-random-seed=271113 scripts/tests/*.test.mjs | 617 | 617 | 0 | 0 | 271113 | 0 | 16.042 |
| hvigor-test | D:/hdm-mall/mixed-development-h5 | & "C:\Program Files\Huawei\DevEco Studio\tools\hvigor\bin\hvigorw.bat" test --mode module | 83 | 83 | 0 | 0 | 未设置 | 0 | 230.561 |
| signed-build | D:/hdm-mall | pwsh -File scripts/verify-optimization-build.ps1 -SkipH5 | 不适用 | 命令成功 | 不适用 | 不适用 | 未设置 | 0 | 111.05 |

命令按表中顺序串行；客户端常规/随机均结束后才启动Hvigor，随后才签名构建。耗时为本次外层Stopwatch墙钟秒，Node runner的duration_ms另保存在checks.json。server-check与signed-build不是测试用例，不以0或构建任务数冒充用例数。

| Hvigor模块 | 实际用例 | 通过 | 失败 | 跳过 |
| --- | --- | --- | --- | --- |
| mixed-development-h5/commons/constants | 0 | 0 | 0 | 0 |
| mixed-development-h5/commons/device | 0 | 0 | 0 | 0 |
| mixed-development-h5/commons/models | 0 | 0 | 0 | 0 |
| mixed-development-h5/commons/network | 5 | 5 | 0 | 0 |
| mixed-development-h5/commons/storage | 0 | 0 | 0 | 0 |
| mixed-development-h5/commons/ui-components | 0 | 0 | 0 | 0 |
| mixed-development-h5/commons/utils | 0 | 0 | 0 | 0 |
| mixed-development-h5/features/cart | 42 | 42 | 0 | 0 |
| mixed-development-h5/features/category | 6 | 6 | 0 | 0 |
| mixed-development-h5/features/home | 26 | 26 | 0 | 0 |
| mixed-development-h5/features/mine | 4 | 4 | 0 | 0 |
| mixed-development-h5/products/phone | 0 | 0 | 0 | 0 |

Hvigor用例按本轮生成的12份test_result.txt中test/result记录逐项解析，结果、名称、suite、文件mtime与SHA256见hvigor-results.json，包含模板断言。构建日志240 tasks（216 executed、24 up-to-date）只是任务数；签名构建438 tasks（363 executed、75 up-to-date）亦不是测试数。

## 源码范围与目录哈希

git ls-files -z 中 server、shoph5-vue3、mixed-development-h5、scripts、contract-kit 的跟踪文件，按上述命名目录分组；排除 node_modules/oh_modules/build/dist/.test/.hvigor/.idea/.vscode/signing 路径段及 resources/rawfile 子树。包含源代码、测试、资源、清单、锁文件及该目录的跟踪文档；不是仅按代码扩展名筛选。未跟踪本地文件、证据 docs 和历史设备记录不计入。 当前contract-kit目录不存在，未虚构文件或哈希。

| 分组 | 文件数 | 清单文件 | 目录SHA256 |
| --- | --- | --- | --- |
| mixed-development-h5 | 15 | source-mixed-development-h5.json | cb88dd3be66672b94d784656667c1bb9aa0b1092bc4eaa9c47e1f559cf9af7ba |
| mixed-development-h5/commons/constants | 12 | source-mixed-development-h5-commons-constants.json | d0cb4535afe6f5e5160608fc93cb1e30de81b7cda09e2440e3d008ba10bac368 |
| mixed-development-h5/commons/device | 17 | source-mixed-development-h5-commons-device.json | 8e13632022558e34e0c6406211d27c4bf7290e9ef43c74b7f575761599ab7407 |
| mixed-development-h5/commons/models | 21 | source-mixed-development-h5-commons-models.json | cfd4e96bd6231ae042896b4451341f5e6d5e04b01647930035f3842ae1735dd0 |
| mixed-development-h5/commons/network | 14 | source-mixed-development-h5-commons-network.json | ab1bd9784f511dfd84b5f8d928e7a48036b6816303595db2bccf3670f12e610b |
| mixed-development-h5/commons/storage | 29 | source-mixed-development-h5-commons-storage.json | d134cd406e6353875b9a8fccbe0077b29760d1bd5da2dbf5e486704b89176e28 |
| mixed-development-h5/commons/ui-components | 52 | source-mixed-development-h5-commons-ui-components.json | 159a113ded9bb0803893445b2f69c9427511970ba9e6e38bc8e8206c424a9278 |
| mixed-development-h5/commons/utils | 18 | source-mixed-development-h5-commons-utils.json | a7cdcd06f147ab457bfe31176997f4b8563dc6224cf07850b28bb5288b8b0fa1 |
| mixed-development-h5/features/cart | 55 | source-mixed-development-h5-features-cart.json | 0e22461d2f13bc466d08e282d4f95cedd9184364e22a8c8f56b15e2267a53aa7 |
| mixed-development-h5/features/category | 25 | source-mixed-development-h5-features-category.json | 92cc12f5f1046e5e902072253af303c38cbee27b8b654c60ef1ad91d3eaaa745 |
| mixed-development-h5/features/home | 56 | source-mixed-development-h5-features-home.json | 49ebe208eaaa991c0ead8e61872a02d055560ce4dfd265cfa84c3457d9ea5d92 |
| mixed-development-h5/features/mine | 66 | source-mixed-development-h5-features-mine.json | 726f67946874e58c65772a870adbd4205a1648b5e833abd7f804a0af5e54b7dc |
| mixed-development-h5/products/phone | 44 | source-mixed-development-h5-products-phone.json | b992933f5a047a0d4c14137fd317bc39fe4bb1b3f4e4d2c37cfd52f282170080 |
| scripts | 126 | source-scripts.json | 75a10329d895be2377ac6aa0e5fcefbea5c1673c5f3a8e269e444f1f4ec25b53 |
| server | 125 | source-server.json | 54f853b10f640261bf47bfe3b9babdaffe73e7f9d23b622011531f08ba38d546 |
| shoph5-vue3 | 29 | source-shoph5-vue3.json | 26c47d65df4e8b5689d7970bfdc5e6b2dea7086aca554a4c0e8bb8cd2d13812b |

所有范围内文件的路径、大小和文件SHA256在对应source清单中；签名材料、依赖树、缓存、生成产物与历史证据不纳入源码清单。原生rawfile单列在产物清单。

## 源产物、包与构建前后变化

| 对象 | 字节数 | SHA256 |
| --- | --- | --- |
| 构建前 mixed-development-h5/build/outputs/default/mixed-development-h5-default-all-signed.app | 9656861 | 3de55f5a31e37af095ed9e3336456ecbedce244461e40b61ad9bd31d76c9097a |
| 构建后 mixed-development-h5/build/outputs/default/mixed-development-h5-default-all-signed.app | 9656849 | 885ded83f3ca1a23069a59c84d7e0420ade59982c4d9c31192f4c96da2d4f60d |
| mixed-development-h5/features/mine/src/main/resources/rawfile/index.html | 584747 | a6175e4433b476e466b8309b9f34aeeeaa5ece81b96b7d630a839d25a2dfabdf |
| shoph5-vue3/dist/index.html | 584714 | 98e27eb0f209e439c514c5756db53a1a251a079e912b1dab78e404e0331a9868 |

artifacts-before.json与artifacts-after.json还逐个记录其余已存在signed/unsigned APP/HAP、favicon及rawfile文本；unsigned单独列出。签名包变化是本轮构建产物变化，跟踪源码未变，未推断签名构建可字节复现。

包内mine-default.hsp/resources/rawfile/index.html与N/features/mine/src/main/resources/rawfile/index.html的SHA256一致（a6175e…abdf），授权脚本匹配1个文件成功。shoph5-vue3/dist/index.html字节SHA256不同，CRLF统一为LF后全文相同；这是当前文件比较结果。-SkipH5没有重建H5，不能据此证明当前H5源码已重新编译或通过H5类型/桥检查；这些独立命令不在本阶段请求清单内。

## 当前入口对照（静态源码证据）

entry-points.json逐项记录76个页面/业务入口的角色、条件、目标、源文件和行号，包含31个原生路由注册；navigation-source.json保留81个导航调用点供遗漏复核。下表路径相对仓库；没有设备点击验收。

| 角色 | 入口 | 目标 | 源文件:行 |
| --- | --- | --- | --- |
| 共用 | 首页 | HomeView | mixed-development-h5/products/phone/src/main/ets/constants/TabConstants.ets:13 |
| 共用 | 分类 | CategoryView | mixed-development-h5/products/phone/src/main/ets/constants/TabConstants.ets:14 |
| 共用 | 购物袋 | CartView | mixed-development-h5/products/phone/src/main/ets/constants/TabConstants.ets:15 |
| 共用 | 我的 | MineView | mixed-development-h5/products/phone/src/main/ets/constants/TabConstants.ets:16 |
| 买家 | 首页搜索 | SearchView | mixed-development-h5/features/home/src/main/ets/presentation/views/HomeView.ets:405 |
| 买家 | 轮播商品入口 | SearchResultView | mixed-development-h5/features/home/src/main/ets/presentation/views/HomeView.ets:393 |
| 买家 | 首页商品分类 | 分类标签/选中分类 | mixed-development-h5/features/home/src/main/ets/presentation/components/HomeCategorySection.ets:29 |
| 买家 | 分类搜索 | SearchView | mixed-development-h5/features/category/src/main/ets/presentation/views/CategoryView.ets:69 |
| 买家 | 二级分类商品 | SearchResultView | mixed-development-h5/features/category/src/main/ets/presentation/views/CategoryView.ets:58 |
| 买家 | 商品卡片 | GoodsView | mixed-development-h5/commons/ui-components/src/main/ets/components/HDMGoods.ets:73 |
| 买家 | 商品客服 | CustomerServiceView | mixed-development-h5/features/home/src/main/ets/presentation/views/GoodsView.ets:727 |
| 买家 | 去购物车 | CartView | mixed-development-h5/features/home/src/main/ets/presentation/views/GoodsView.ets:655 |
| 买家 | 加入购物袋 | 商品规格选择/加入购物袋 | mixed-development-h5/features/home/src/main/ets/presentation/views/GoodsView.ets:745 |
| 买家 | 立即购买 | CheckView（经规格选择） | mixed-development-h5/features/home/src/main/ets/presentation/views/GoodsView.ets:618 |
| 买家 | 购物袋去结算 | CheckView | mixed-development-h5/features/cart/src/main/ets/presentation/views/CartView.ets:506 |
| 买家 | 结算收货地址 | AddressView | mixed-development-h5/features/cart/src/main/ets/presentation/views/CheckView.ets:511 |
| 买家 | 提交订单并付款 | PayView/OrderDetailView（按付款方式与状态） | mixed-development-h5/features/cart/src/main/ets/presentation/views/CheckView.ets:899 |
| 共用 | 立即登录 | LoginView | mixed-development-h5/features/mine/src/main/ets/presentation/views/MineView.ets:162 |
| 共用 | 编辑资料 | WebView → H5 /profile | mixed-development-h5/features/mine/src/main/ets/presentation/views/MineView.ets:154 |
| 共用 | 设置 | SettingsView（SettingView.ets） | mixed-development-h5/features/mine/src/main/ets/presentation/views/MineView.ets:131 |
| 买家 | 亲友中心 · 代付与代收 | FamilyView；未登录转 LoginView | mixed-development-h5/features/mine/src/main/ets/presentation/views/MineView.ets:243 |
| 共用 | 我的收藏 | FavoritesView | mixed-development-h5/features/mine/src/main/ets/presentation/views/MineView.ets:255 |
| 共用 | 我的足迹 | HistoryView | mixed-development-h5/features/mine/src/main/ets/presentation/views/MineView.ets:266 |
| 共用 | 我的客服 | CustomerServiceView / 商家为 MerchantServiceView | mixed-development-h5/features/mine/src/main/ets/presentation/views/MineView.ets:278 |
| 买家 | 全部订单 | OrderView 参数 0 | mixed-development-h5/features/mine/src/main/ets/presentation/views/MineView.ets:313 |
| 买家 | 待付款 | OrderView 参数 1 | mixed-development-h5/features/mine/src/main/ets/presentation/views/MineView.ets:321 |
| 买家 | 待发货 | OrderView 参数 2 | mixed-development-h5/features/mine/src/main/ets/presentation/views/MineView.ets:329 |
| 买家 | 待收货 | OrderView 参数 3 | mixed-development-h5/features/mine/src/main/ets/presentation/views/MineView.ets:337 |
| 买家 | 待评价 | OrderView 参数 4 | mixed-development-h5/features/mine/src/main/ets/presentation/views/MineView.ets:345 |
| 买家 | 注销处理中进度/撤销 | AccountDeletionView | mixed-development-h5/features/mine/src/main/ets/presentation/views/MineView.ets:238 |
| 共用 | 设置个人信息 | WebView → H5 /profile | mixed-development-h5/features/mine/src/main/ets/presentation/views/SettingView.ets:78 |
| 共用 | 收货地址管理 | AddressView | mixed-development-h5/features/mine/src/main/ets/presentation/views/SettingView.ets:151 |
| 共用 | 隐私政策 | 隐私全文弹窗 | mixed-development-h5/features/mine/src/main/ets/presentation/views/SettingView.ets:154 |
| 共用 | 用户协议 | 协议全文弹窗 | mixed-development-h5/features/mine/src/main/ets/presentation/views/SettingView.ets:155 |
| 共用 | 撤回同意 | 确认弹窗/退出登录 | mixed-development-h5/features/mine/src/main/ets/presentation/views/SettingView.ets:30 |
| 买家 | 注销账号 | AccountDeletionView | mixed-development-h5/features/mine/src/main/ets/presentation/views/SettingView.ets:158 |
| 共用 | 退出登录 | 退出确认弹窗 | mixed-development-h5/features/mine/src/main/ets/presentation/views/SettingView.ets:164 |
| 商家 | 对账 | ReconciliationView | mixed-development-h5/features/mine/src/main/ets/presentation/views/MineView.ets:219 |
| 商家 | 客服留言 | MerchantServiceView | mixed-development-h5/features/mine/src/main/ets/presentation/views/MineView.ets:221 |
| 商家 | 满减设置 | PromotionSettingView | mixed-development-h5/features/mine/src/main/ets/presentation/views/MineView.ets:222 |
| 商家 | 操作记录 | AuditLogView | mixed-development-h5/features/mine/src/main/ets/presentation/views/MineView.ets:224 |
| 商家 | 库存管理 | InventoryView | mixed-development-h5/features/mine/src/main/ets/presentation/views/MineView.ets:227 |
| 商家 | 商品管理 | ProductManageView | mixed-development-h5/features/mine/src/main/ets/presentation/views/MineView.ets:230 |
| 商家 | 售后管理 | AfterSaleManageView | mixed-development-h5/features/mine/src/main/ets/presentation/views/MineView.ets:233 |
| 商家 | 亲友中心 / 商家发货 | FamilyView | mixed-development-h5/features/mine/src/main/ets/presentation/views/MineView.ets:243 |
| 买家 | 亲友：待我付款 | FamilyView 分组 | mixed-development-h5/features/mine/src/main/ets/presentation/views/FamilyView.ets:858 |
| 买家 | 亲友：待我收货 | FamilyView 分组 | mixed-development-h5/features/mine/src/main/ets/presentation/views/FamilyView.ets:858 |
| 买家 | 亲友：待处理 | FamilyView 分组 | mixed-development-h5/features/mine/src/main/ets/presentation/views/FamilyView.ets:859 |
| 买家 | 亲友：全部订单 | FamilyView 分组 | mixed-development-h5/features/mine/src/main/ets/presentation/views/FamilyView.ets:859 |
| 共用 | 亲友关系管理 | 绑定邀请/同意/解除关系 | mixed-development-h5/features/mine/src/main/ets/presentation/views/FamilyView.ets:875 |
| 商家 | 商家发货分组 | FamilyView merchant 分组 | mixed-development-h5/features/mine/src/main/ets/presentation/views/FamilyView.ets:881 |
| 商家 | 确认发货 | 承运商/运单表单 → 提交发货 | mixed-development-h5/features/mine/src/main/ets/presentation/views/FamilyView.ets:839 |
| 商家 | 处理取消申请 | 同意取消 / 拒绝并发货表单 | mixed-development-h5/features/mine/src/main/ets/presentation/views/FamilyView.ets:831 |
| 商家 | 商家订单详情 | MerchantOrderView | mixed-development-h5/features/mine/src/main/ets/presentation/views/FamilyView.ets:844 |
| 买家 | 亲友付款与订单详情 | OrderDetailView | mixed-development-h5/features/mine/src/main/ets/presentation/views/FamilyView.ets:793 |
| 商家 | 新建商品 | ProductEditView，空 id | mixed-development-h5/features/mine/src/main/ets/presentation/views/ProductManageView.ets:99 |
| 商家 | 编辑 | ProductEditView，商品 id | mixed-development-h5/features/mine/src/main/ets/presentation/views/ProductManageView.ets:114 |
| 商家 | 评价 | ReviewManageView | mixed-development-h5/features/mine/src/main/ets/presentation/views/ProductManageView.ets:115 |
| 商家 | 商品上下架 | 原页状态操作/未知结果确认 | mixed-development-h5/features/mine/src/main/ets/presentation/views/ProductManageView.ets:116 |
| 商家 | 对账订单详情 | MerchantOrderView | mixed-development-h5/features/mine/src/main/ets/presentation/views/ReconciliationView.ets:91 |
| 商家 | 按日查询对账 | 原页报表 | mixed-development-h5/features/mine/src/main/ets/presentation/views/ReconciliationView.ets:112 |
| 商家 | 开始对账 | 原页报表 | mixed-development-h5/features/mine/src/main/ets/presentation/views/ReconciliationView.ets:113 |
| 商家 | 差异处理 | 原因表单/保存处理结果 | mixed-development-h5/features/mine/src/main/ets/presentation/views/ReconciliationView.ets:100 |
| 商家 | 客服查看并回复 | MerchantServiceThread → CustomerServiceView | mixed-development-h5/features/mine/src/main/ets/presentation/views/MerchantServiceView.ets:59 |
| 商家 | 调整库存 | 原页库存调整表单 | mixed-development-h5/features/mine/src/main/ets/presentation/views/InventoryView.ets:300 |
| 商家 | 默认退货地址 | 原页退货地址表单 | mixed-development-h5/features/mine/src/main/ets/presentation/views/AfterSaleManageView.ets:292 |
| 商家 | 售后同意 | 原页同意表单 | mixed-development-h5/features/mine/src/main/ets/presentation/views/AfterSaleManageView.ets:268 |
| 商家 | 售后拒绝 | 原页拒绝原因表单 | mixed-development-h5/features/mine/src/main/ets/presentation/views/AfterSaleManageView.ets:269 |
| 商家 | 验收退款/补验收入库 | 原页验收数量/退款表单 | mixed-development-h5/features/mine/src/main/ets/presentation/views/AfterSaleManageView.ets:272 |
| 买家 | 订单详情 | OrderDetailView | mixed-development-h5/features/cart/src/main/ets/presentation/views/OrderView.ets:644 |
| 买家 | 去支付 | PayView | mixed-development-h5/features/cart/src/main/ets/presentation/views/OrderDetailView.ets:474 |
| 买家 | 去评价 | EvaluationView | mixed-development-h5/features/cart/src/main/ets/presentation/views/OrderDetailView.ets:539 |
| 买家 | 申请售后 | AfterSaleApplyView | mixed-development-h5/features/cart/src/main/ets/presentation/views/OrderDetailView.ets:615 |
| 买家 | 联系客服 | CustomerServiceView | mixed-development-h5/features/cart/src/main/ets/presentation/views/OrderDetailView.ets:654 |
| 买家 | 刷新物流 | 原页物流轨迹 | mixed-development-h5/features/cart/src/main/ets/presentation/views/OrderDetailView.ets:611 |
| 共用 | H5 个人信息 | src/views/ProfileEdit.vue | shoph5-vue3/src/router/index.ts:11 |

“立即开通”会员按钮在MineView中有UI但未绑定onClick，未列作已可用业务入口。商家动态目的页由壳页Index.ets的navDestination注册，不只靠router_map.json；SettingsView实际源文件是SettingView.ets，结算目标是CheckView。

## 失败、告警与限制

本轮7条请求命令无失败。Hvigor模块测试与签名构建均输出ArkTS WARN，例如可能抛出异常需要特殊处理；未修代码、未消警、未放宽校验。log-index.json记录各原日志SHA256、原字节数、警告行数、关键例子及提取规则；精简日志保留原行号、关键警告和末尾结果，完整日志只留系统临时目录，未放入仓库。

限制：零用例模块不代表行为通过；入口清单来自源码；未操作模拟器，未验证真实支付/物流、生产部署、API24设备安装或端到端交互；未升级依赖或重建H5；安装SDK API26不代表本项目已迁移到API26。所有取值均为本机本轮观测，未用历史数字补结果。

## 复算方法

文件哈希：PowerShell Get-FileHash -Algorithm SHA256 -LiteralPath <清单中的绝对路径>。先核对HEAD/分支/Git状态和各manifest、lock、build-profile及hvigor哈希，再按checks.json中的cwd/command串行复跑；随机种子固定271113。完整长日志放临时目录，记录真实退出码与计数。

目录哈希：路径列表取git ls-files -z并按source-summary.json.scope筛选。N/features、N/commons、N/products各以模块目录分组，其余N根和server、shoph5-vue3、scripts按顶层分组；用JavaScript默认sort排序相对路径，文件SHA256按磁盘原字节。每行拼成小写sha256、两个ASCII空格、斜杠相对路径、一个LF字节0x0A；所有行以UTF-8无BOM串接后计算SHA256。大小记录不参与目录哈希；换行不归一化。为检测新增/删除文件，应重新枚举Git列表并与清单路径集合比较，不能仅重哈希既有清单项。

artifact-after字段的大小和哈希可按路径重算；包内一致性由scripts/verify-package-web.ps1核验。若重新构建，重新冻结包及SHA256，不能沿用本次包哈希。verification.json记录本轮构建后的源码/配置复算通过。

## 文件索引与封版

versions.json：版本、依赖和文件哈希；native-configs.json：原生配置；runtime.json：机器工具链；preflight.json：开工核对；source-summary及16份source清单：源码；artifacts-before/after：产物；checks.json、hvigor-results.json、log-index.json及8份txt日志：检查；entry-points/navigation-source：入口；git-before-build/git-after-build：Git状态；verification.json：复算证明；file-manifest.json：封版时各证据文件的大小和SHA256（不含自身及发送后才生成的delivery-receipt.json）。

最终Git状态：## mall-crazy-design-20261116；?? docs/refactor-evidence/。未git add、commit、push、stash、reset、checkout或clean。提交与正式复核交由原Claude会话；本轮不修改docs/执行须知.md。

## 历史参考（不计入本轮）

docs/执行须知.md历史记录含服务端362、客户端617、Hvigor83；仅在本节作为历史参考。本轮表格独立来自2026-11-17实际命令输出与新模块报告，即使数字相同，也不是沿用历史验收。
