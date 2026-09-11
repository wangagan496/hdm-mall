"""DevEco Testing Hypium 场景清单。

使用方式：
1. 确认设备已连接：hdc list targets
2. 已内置真实包名 com.hdm.mall（AppScope/app.json5）与源码级控件定位（pages.py）
3. 本文件只维护场景注册表，不伪装成本地 Python runner。实际执行需要
   DevEco Testing 提供的 Hypium runner 注入设备与测试生命周期。

推荐执行顺序（对应 docs/测试用例表-下单业务.md）：
    test_01_login              登录（TC-001/002 + 协议拦截）
    test_02_search             搜索（TC-004/005 + 拼音）
    test_03_sku_boundary       SKU 边界（重点组 A）
    test_04_cart_pay           购物袋→结算→支付主流程
    test_05_account_isolation  多账号隔离（重点组 B）

已知环境依赖：
- 测试商品"牙膏"需在后台真实存在
- 支付环节为 ArkWeb H5 收银台，付款结果需人工确认（TC-010 步骤 3）
- MineView 设置图标定位依赖 accessibilityText('设置')，若 UIViewer 抓取
  到不同属性，仅需调整 pages.py 中 MinePage.SETTINGS_ICON
"""

SUITE_NAMES = [
    "test_01_login",
    "test_02_search",
    "test_03_sku_boundary",
    "test_04_cart_pay",
    "test_05_account_isolation",
]

# 没有固定后端夹具或真实支付环境的场景必须由人工/设备验收。
MANUAL_CASES = {
    "test_03_sku_boundary": ["SKU-03", "SKU-04", "SKU-06", "SKU-11"],
    "test_04_cart_pay": ["TC-010 payment result", "TC-011"],
}

if __name__ == "__main__":
    print("DevEco Testing Hypium scenario manifest (not an executable runner)")
    for suite_name in SUITE_NAMES:
        print(f"registered suite: {suite_name}")
    for suite, cases in MANUAL_CASES.items():
        print(f"manual/fixture-required {suite}: {', '.join(cases)}")
