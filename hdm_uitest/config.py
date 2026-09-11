"""全局配置：包名、测试账号、测试数据与提示文案。

包名提取自 AppScope/app.json5: bundleName = com.hdm.mall
文案均提取自 features 下各 View.ets 源码中的 safeToast/showToast 调用。
"""

BUNDLE_NAME = "com.hdm.mall"

ACCOUNT_A = ("test_a", "123456")
ACCOUNT_B = ("test_b", "123456")

# 搜索模块测试数据（对应导图搜索测试点）
KEYWORD_HIT = "牙膏"          # 汉字命中
KEYWORD_PINYIN = "yagao"      # 拼音
KEYWORD_EMPTY = ""            # 空词（SearchView.trim() 后为空直接 return，停留在搜索页）

# SKU/交易边界测试数据
# 详情页数量为 Counter 组件（enableDec(count>1)、enableInc(count<库存)），
# 0 与超库存由组件天然拦截，自动化重点验证输入非法值与快速切换场景。
QTY_OVER_STOCK = "999999"
QTY_ILLEGAL = ["-1", "abc", "1.5"]

# Toast/提示文案（提取自源码）
TOAST_NOT_LOGIN = "您还未登录"                       # GoodsView.addToCart 未登录
TOAST_NO_SPEC = "请选择对应的产品规格"               # GoodsView.addToCart 未选 SKU
TOAST_SKU_FALLBACK = "商品规格加载失败，请返回重试"   # GoodsView 兜底 SKU
TOAST_ADD_SUCCESS = "加入购物车成功"                  # GoodsView 加购成功
TOAST_SETTLE_NO_SELECT = "请选择要结算的商品"         # CartView 去结算未勾选
TOAST_SUBMIT_FAIL = "提交订单失败，请稍后重试"        # CheckView
PAGE_PAY_SUCCESS = "付款成功"                         # PayResultView
PAGE_PAY_FAIL = "付款失败"                            # PayResultView
ORDER_STATE_UNPAID = "待付款"                         # OrderView Tab

# 主流程测试商品（需环境后台存在该商品；可按实际环境调整）
GOODS_NAME = "牙膏"
