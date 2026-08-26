# HarmonyOS Image 商品卡片布局官方文档核对

核对日期：2026-08-26  
适用项目：`D:\hdm-mall\mixed-development-h5`  
本机基线：DevEco Studio 6.1.1 / HarmonyOS SDK 6.1.1（API 24）

## 结论

1. `objectFit` 只决定图像内容如何装入 **已经测量出的 Image 显示边界**，它不负责给商品卡片建立稳定高度。官方声明其默认值为 `ImageFit.Cover`。
2. `ImageFit.Contain` 保持宽高比并保证整张图都落在显示边界内，代价是源图比例与容器不一致时会留白；`ImageFit.Cover` 保持宽高比并保证两个方向都覆盖显示边界，代价是超出部分被裁剪。
3. 官方 `aspectRatio` 定义为 `width / height`。只设置 `width` 和 `aspectRatio` 时，框高为 `width / aspectRatio`；同时设置 `width`、`height`、`aspectRatio` 时，显式 `height` 被忽略。
4. 当前商品数据的源图比例、主体位置和自带白边并不统一。截图中的头盔、童鞋、充电宝等被切掉，符合 `Cover` 在固定槽内裁剪的语义，不是图片请求失败。因此，这个项目的商品列表主图应优先使用 **固定比例图片槽 + `ImageFit.Contain`**。若以后服务端提供统一裁切、统一主体安全区的缩略图，才适合改用 `Cover`。
5. 不应让网络原图的固有尺寸决定 `WaterFlow` 项高度。官方文档说明：`Image` 不设置宽高时，加载成功后显示尺寸会自适应父组件；在瀑布流中，这会让异步加载和不同源图比例参与布局。商品卡片应先确定槽尺寸，再让图片填充槽。

## 官方语义与证据

### `Image` 的默认行为

HarmonyOS/OpenHarmony 官方 Image 文档写明：

- Image 默认按照居中裁剪；组件宽高相同而原图宽高不同时，会裁取中间区域。
- Image 加载成功且组件不设置宽高时，显示大小自适应父组件。
- `objectFit` 未设置时默认为 `ImageFit.Cover`。

官方入口：

- [HarmonyOS Image 组件 API](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/ts-basic-components-image)
- [OpenHarmony 官方 Image 文档源码](https://github.com/openharmony/docs/blob/master/zh-cn/application-dev/reference/apis-arkui/arkui-ts/ts-basic-components-image.md)

本机 SDK 一手声明：

- `C:\Huawei\DevEco Studio\sdk\default\openharmony\ets\component\image.d.ts:1156-1164`：`objectFit` 设置图像适配容器的方式，默认值为 `ImageFit.Cover`。
- `C:\Huawei\DevEco Studio\sdk\default\openharmony\ets\component\image.d.ts:990-1035`：`fitOriginalSize` 控制显示尺寸是否跟随图源尺寸，默认值为 `false`。

### `Contain` 与 `Cover`

官方 `ImageFit` 枚举定义：

| 模式 | 官方语义 | 对商品卡片的结果 |
| --- | --- | --- |
| `Contain` | 保持宽高比缩放，使图片完全显示在显示边界内 | 商品主体不会被裁掉，比例不同时留白 |
| `Cover` | 保持宽高比缩放，使图片两个方向都大于或等于显示边界 | 槽被填满，但长图、宽图会被裁掉 |
| `Fill` | 不保持宽高比缩放并填满边界 | 会拉伸商品，不适合主图 |

官方入口：

- [HarmonyOS ImageFit 枚举](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/ts-appendix-enums#imagefit)
- [OpenHarmony 官方 ImageFit 文档源码](https://github.com/openharmony/docs/blob/master/zh-cn/application-dev/reference/apis-arkui/arkui-ts/ts-appendix-enums.md#imagefit)

本机 SDK 一手声明：

- `C:\Huawei\DevEco Studio\sdk\default\openharmony\ets\component\enums.d.ts:634-704`：`Contain` 完整显示；`Cover` 两个方向覆盖边界。

### `aspectRatio` 的测量规则

官方规则是：

```text
aspectRatio = width / height
只有 width + aspectRatio：height = width / aspectRatio
只有 height + aspectRatio：width = height * aspectRatio
width + height + aspectRatio：height 不生效，以 width / aspectRatio 计算
```

组件仍受父组件内容区约束，且 `constraintSize` 的优先级高于 `aspectRatio`。因此，商品图片槽使用 `.width('100%').aspectRatio(1)` 可以在两列宽度确定后稳定推导出正方形高度，但父容器必须确实给出可用宽度。

官方入口：

- [HarmonyOS 布局约束 aspectRatio](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/ts-universal-attributes-layout-constraints#aspectratio)
- [OpenHarmony 官方布局约束文档源码](https://github.com/openharmony/docs/blob/master/zh-cn/application-dev/reference/apis-arkui/arkui-ts/ts-universal-attributes-layout-constraints.md#aspectratio)

本机 SDK 一手声明：

- `C:\Huawei\DevEco Studio\sdk\default\openharmony\ets\component\common.d.ts:25552-25584`：`aspectRatio(value: number)` 是所有通用组件的布局约束属性。

## 对本项目的推荐写法

普通商品卡片应建立一个与列宽绑定的稳定正方形槽，再让 Image 完整显示在槽中：

```ets
Row() {
  Image(this.goods.picture)
    .width('100%')
    .height('100%')
    .objectFit(ImageFit.Contain)
}
.width('100%')
.aspectRatio(1)
.clip(true)
```

也可以使用明确的 `.height(...)`，但断点下需要同步维护宽高关系。当前两列响应式布局更适合 `.width('100%').aspectRatio(1)`，因为列宽改变时图片槽会自动保持正方形。

不要同时在图片槽上写 `.height(fixedValue)` 和 `.aspectRatio(1)` 并期待固定高度生效；按官方优先规则，已有宽度时 `aspectRatio` 会重新计算高度。

`smallImage` 若是搜索结果缩略图，同样建议使用稳定槽和 `Contain`。只有横幅、营销背景或已经保证主体安全区的统一裁切图，才应使用 `Cover`。

## 验收边界

以上是官方语义和针对当前源图的代码选择结论。是否彻底修复仍需安装最新 `.app` 后，在设备上核对至少一张竖图、一张横图、一张自带大白边图：卡片高度一致、商品主体完整、文字与价格不被覆盖、列表滚动过程中布局不跳动。构建成功本身不能替代这项视觉验收。
