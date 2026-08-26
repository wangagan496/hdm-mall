# HarmonyOS 官方规则核对（2026-08-26）

范围：`D:\hdm-mall\mixed-development-h5` 中 Claude 本轮改动；基线为本机 DevEco Studio 6.1.1 / HarmonyOS SDK 6.1.1（API 24）。网页正文由官方站点动态加载，以下同时保留官方文档入口和本机随 SDK/工具链附带的一手声明、schema、编译器输出。

## 结论摘要

当前改动 **不 OK，不能视为可合入或构建通过**。项目级命令：

```text
C:\Huawei\DevEco Studio\tools\hvigor\bin\hvigorw.bat assembleApp --mode project --no-incremental
```

实际结果：`BUILD FAILED`，`COMPILE RESULT:FAIL {ERROR:13 WARN:50}`。关键错误集中在新文件 `CartOperations.ets`、`HomeGoodsDeduplication.ets`，另有导出符号、路由常量和模块导入错误。完整错误原文应以本次构建日志为准，不能用“有 WARN 但可运行”替代。

## 逐项官方核对

### 1. `any` / `unknown`

**官方规则：适用于 ArkTS 源码，不允许用 `any` 或 `unknown` 逃避显式类型。** 当前编译器明确报：

```text
10605008 Use explicit types instead of "any", "unknown" (arkts-no-any-unknown)
CartOperations.ets:42:11
CartOperations.ets:46:19
```

本机一手证据：`C:\Huawei\DevEco Studio\sdk\default\openharmony\ets\build-tools\ets-loader\`（ArkTS 编译器随 SDK）；构建输出中的规则名和错误码是当前 API 24 编译器实际执行结果。不要把 SDK 自身 `.d.ts`/Hvigor 实现里出现的 `any` 当作业务 ArkTS 放宽依据。

官方入口：

- [ArkTS 语言概述（官方）](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/arkts-overview)
- [ArkTS 语言限制/迁移指南（官方）](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/arkts-restrictions)

### 2. 独立函数中的 `this`；为何 `static` 方法也被命中

**规则：独立函数（stand-alone function）不得使用 `this`。** 当前错误为：

```text
10605093 Using "this" inside stand-alone functions is not supported (arkts-no-standalone-this)
HomeGoodsDeduplication.ets:36:67, 40:74, 45:72, 46:93
```

触发点是 `static processHomeGoods(...)` 内的 `this.PROMOTION_LIMIT`。这里的 `this` 是静态方法所属的类构造函数上下文，不是实例对象；但 API 24 ArkTS 严格检查器仍将该方法按“stand-alone function”限制处理，因而命中同一规则。应改为显式类名常量（例如 `HomeGoodsDeduplication.PROMOTION_LIMIT`，若该访问方式仍受检查则把常量移为模块级 `const`），不要用 `this` 绕过规则。

官方入口：[ArkTS 语言限制/迁移指南（官方）](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/arkts-restrictions)

本机编译器规则实现随 SDK 位于：`C:\Huawei\DevEco Studio\sdk\default\openharmony\ets\build-tools\ets-loader`。

### 3. 对象字面量作为类型，以及无显式类/接口的对象字面量

两条是不同错误，当前都命中：

```text
10605040 Object literals cannot be used as type declarations (arkts-no-obj-literals-as-types)
HomeGoodsDeduplication.ets:29:6

10605038 Object literal must correspond to some explicitly declared class or interface (arkts-no-untyped-obj-literals)
HomeGoodsDeduplication.ets:51:12
```

因此返回类型不能直接写 `{ saleGoods: ...; ... }`，应先声明并命名 `interface HomeGoodsResult`；返回对象也必须赋给/对应显式声明的接口或类。此处不能只靠 TypeScript 的结构推断说“字段一样所以可以”。

官方入口：[ArkTS 语言限制/迁移指南（官方）](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/arkts-restrictions)

### 4. HAR/HSP 模块依赖必须声明

官方 OHPM schema 明确要求模块依赖写在 `oh-package.json5` 的 `dependencies`（运行时/发布所需）或 `devDependencies`（仅开发/测试）；schema 说明依赖值可以是同项目模块目录或 tarball。当前构建还实际警告：

```text
Local dependencies detected during har packing of module storage.
Check ... commons/storage/oh-package.json5 and replace the local dependencies.
```

本机一手证据：`C:\Huawei\DevEco Studio\tools\ohpm\resources\schemas\oh-package-json5-schema.json:27-35,151-154`；`C:\Huawei\DevEco Studio\tools\hvigor\hvigor-ohos-plugin\types\index.d.ts:2732-2743` 明确区分模块级与工程级 `oh-package.json5` 的 HAR 依赖收集。

官方入口：

- [OHPM/oh-package.json5（官方）](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-ohpm)
- [Hvigor 构建配置与依赖（官方）](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-hvigor-build-profile)

审查判断：依赖声明本身是必要条件；对 HAR 发布还要避免把仅本机路径的 local dependency 原样带进可安装产物，按构建警告替换为可解析的包/产物依赖。

### 5. `promptAction.showToast` 的废弃状态与替代 API

本机 API 24 SDK 的官方声明明确写出：

```text
@deprecated since 18
@useinstead ohos.arkui.UIContext.PromptAction#showToast
function showToast(options: ShowToastOptions): void;
```

路径：`C:\Huawei\DevEco Studio\sdk\default\openharmony\js\api\@ohos.promptAction.d.ts:1877-1880`。

替代 API 同一 SDK 明确提供：

```text
UIContext.getPromptAction(): PromptAction
PromptAction.showToast(options): void
```

路径：`C:\Huawei\DevEco Studio\sdk\default\openharmony\js\api\@ohos.arkui.UIContext.d.ts:1015,4107`。

当前改动中的 `ErrorHandler.ets` 仍 `import { promptAction } from '@kit.ArkUI'` 并调用 `promptAction.showToast`；这不是官方推荐写法，应改为从拥有 UIContext 的组件调用 `this.getUIContext().getPromptAction().showToast(...)`，或把 UIContext 作为显式参数传入工具层。项目中其他已使用 `getUIContext().getPromptAction()` 的调用方向是正确的。

官方 API 参考：

- [PromptAction API（官方）](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-promptAction)
- [UIContext API（官方）](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-arkui-UIContext)

### 6. `signingConfigs` 中 `password`/路径的安全与可移植性

`build-profile.json5` 的签名 schema/构建配置允许 `certpath`、`profile`、`storeFile`、`storePassword`、`keyPassword` 等字段，但把真实密码和用户目录绝对路径提交到项目不是可移植或安全的工程配置。当前改动新增了：

```text
C:\Users\23203\.ohos\config\...
storePassword: 明文
keyPassword: 明文
```

结论应表述为：**官方构建配置支持这些字段，不等于官方建议把秘密硬编码并纳入版本库。** 应使用 DevEco Studio/本机签名管理产生的未提交本地配置、环境/CI secret 或安全凭据注入；证书、公钥 profile 与私钥/密码分开管理，生产签名不可使用 debug 签名。绝对路径也应改为本机生成或 CI 注入，避免换机器失效。

官方入口：

- [Hvigor/build-profile.json5 签名配置（官方）](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-hvigor-build-profile)
- [应用签名与发布（官方）](https://developer.huawei.com/consumer/cn/doc/app/agc-help-signature-info-0000001100114407)

## 本轮审查后的处理意见

在修复下列构建错误前不能判定 Claude 改动 OK：`CartOperations.ets` 的 `any/unknown`、错误的 `utils` 导入、缺失的 `CartOperations` 导出、`number`/`string` 参数不匹配；`HomeGoodsDeduplication.ets` 的 `static this`、对象字面量类型与返回对象接口；`CartView.ets` 的不存在的 `PAGE_PATH.ORDER_CONFIRM_PAGE`。此外应将 `ErrorHandler.ets` 的废弃 toast 调用迁移到 UIContext 方案，并清理或隔离签名秘密和机器绝对路径。

