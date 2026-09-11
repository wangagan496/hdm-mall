export default function testsuite() {
  // products/phone 目前没有可脱离 UI 环境验证的纯逻辑单元（TabConstants 依赖 $r 资源，
  // Ability 依赖运行时上下文），业务用例集中在 home/category/cart/mine 各模块的 test 目录。
}
