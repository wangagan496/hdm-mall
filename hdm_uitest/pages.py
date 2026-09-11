"""页面元素定位仓库（POM）。

所有定位均提取自 hdm-mall 源码（mixed-development-h5）：
- 底部 Tab: products/phone/src/main/ets/constants/TabConstants.ets（首页/分类/购物袋/我的）
- 登录页:   features/mine/.../views/LoginView.ets（TextInput placeholder + Button('登录')）
- 我的页:   features/mine/.../views/MineView.ets（accessibilityText + HDMNavCol 文本）
- 设置页:   features/mine/.../views/SettingView.ets（HDMCell('退出登录')，确认弹窗 HDMConfirm 取消/确定）
- 搜索页:   features/home/.../views/SearchView.ets（Search 组件 placeholder '商品关键字...' + searchButton('搜索')）
- 详情页:   features/home/.../views/GoodsView.ets（'加入购物袋'/'立即购买'，收藏 accessibilityText，半模态 Counter）
- 购物袋:   features/cart/.../views/CartView.ets（'去结算'，空态 tip '购物车空空哒'/'您当前未登录'）
- 结算页:   features/cart/.../views/CheckView.ets（'提交订单'/'立即支付'）
- 支付结果: features/cart/.../views/PayResultView.ets（'付款成功'/'付款失败'）
- 订单页:   features/cart/.../views/OrderView.ets（Tab: 待付款/待发货/待收货/待评价）

搜索组件无 id，Hypium 中用 BY.type('Search') 定位；Checkbox 用 accessibilityText 定位。
"""

from hypium import BY


class TabBar:
    HOME = BY.text("首页")
    CATEGORY = BY.text("分类")
    CART = BY.text("购物袋")
    MINE = BY.text("我的")


class LoginPage:
    # LoginView: TextInput({ placeholder: '请输入账号/手机号' }) / TextInput({ placeholder: '请输入密码' })
    ACCOUNT_INPUT = BY.type("TextInput").placeholder("请输入账号/手机号")
    PASSWORD_INPUT = BY.type("TextInput").placeholder("请输入密码")
    LOGIN_BTN = BY.text("登录")
    AGREE_CHECKBOX = BY.text("查看并同意")


class MinePage:
    # MineView: 未登录时显示 Text('立即登录')；已登录显示 '编辑资料'
    LOGIN_ENTRY = BY.text("立即登录")
    EDIT_PROFILE = BY.text("编辑资料")
    SETTINGS_ICON = BY.accessibilityText("设置")
    # HDMNavCol text
    FAVORITES = BY.text("我的收藏")
    HISTORY = BY.text("我的足迹")
    ORDERS_ALL = BY.text("全部订单")
    ORDERS_UNPAID = BY.text("待付款")


class SettingPage:
    # SettingView: HDMCell({ title: '退出登录' }) → HDMConfirm 弹窗（Text 取消/确定）
    LOGOUT_CELL = BY.text("退出登录")
    CONFIRM_BTN = BY.text("确定")
    CANCEL_BTN = BY.text("取消")
    LOGOUT_FAIL_TOAST = "退出失败，请稍后重试"


class SearchPage:
    # SearchView: Search({ placeholder: '商品关键字...' }) + searchButton('搜索')
    SEARCH_BOX = BY.type("Search")
    SEARCH_BTN = BY.text("搜索")


class GoodsPage:
    # GoodsView 底栏与半模态
    ADD_CART_BTN = BY.text("加入购物袋")
    BUY_NOW_BTN = BY.text("立即购买")
    # 收藏按钮: Image accessibilityText('收藏商品')，已收藏为 '取消收藏'
    COLLECT_BTN = BY.accessibilityText("收藏商品")
    UNCOLLECT_BTN = BY.accessibilityText("取消收藏")
    # 半模态 Counter 计数器文本
    QTY_TEXT = BY.type("Counter")
    # 详情页 Toast 文案（源自 GoodsView.ets）
    TOAST_NOT_LOGIN = "您还未登录"
    TOAST_NO_SPEC = "请选择对应的产品规格"
    TOAST_SKU_FALLBACK = "商品规格加载失败，请返回重试"
    TOAST_ADD_SUCCESS = "加入购物车成功"
    TOAST_ADD_FAIL = "加入购物车失败，请稍后重试"
    TOAST_COLLECT_OK = "收藏成功"
    TOAST_COLLECT_CANCEL = "已取消收藏"
    INVENTORY_NONE = "暂时缺货"
    INVENTORY_PICK_SPEC = "请选择规格"


class CartPage:
    # CartView: NavBar title '购物袋'；空态 HDMEmpty tip
    TITLE = BY.text("购物袋")
    EMPTY_TIP = BY.text("购物车空空哒")
    NOT_LOGIN_TIP = BY.text("您当前未登录")
    GO_LOGIN_BTN = BY.text("去登录")
    SETTLE_BTN = BY.text("去结算")
    SELECT_ALL = BY.accessibilityText("全选商品")
    CANCEL_ALL = BY.accessibilityText("取消全选")
    # 去结算未勾选商品时 toast
    TOAST_NOT_SELECTED = "请选择要结算的商品"


class CheckPage:
    # CheckView: '立即支付'（loading 时 '提交中...'）与 '提交订单' 两处按钮
    PAY_NOW_BTN = BY.text("立即支付")
    SUBMIT_ORDER_BTN = BY.text("提交订单")
    TOAST_SUBMIT_FAIL = "提交订单失败，请稍后重试"
    NO_ADDRESS_TIP = BY.text("还没有收货地址，请先添加")


class PayResultPage:
    # PayResultView
    SUCCESS_TITLE = BY.text("付款成功")
    FAIL_TITLE = BY.text("付款失败")
    RECHECK_BTN = BY.text("重新查单")


class OrderPage:
    # OrderView Tab 标签
    TAB_UNPAID = BY.text("待付款")
    TAB_UNSHIPPED = BY.text("待发货")
    TAB_UNRECEIVED = BY.text("待收货")
    TAB_UNEVALUATED = BY.text("待评价")


class FavoritesPage:
    # FavoritesView 空态
    EMPTY_TIP = BY.text("还没有收藏商品")
    GO_AROUND_BTN = BY.text("去逛逛")


class HistoryPage:
    # HistoryView
    EMPTY_TIP = BY.text("还没有浏览足迹")
    TITLE = BY.text("最近浏览")
    CLEAR_BTN = BY.text("清空")
