"""用例基类：统一前置/后置与通用业务动作。

前置：启动 APP 并等待首页 Tab 加载完成。
后置：回到首页 Tab，保证用例之间相互独立。

注意：项目为 Navigation 导航结构（无独立登录 Activity），
登录页通过 我的 Tab → 立即登录 进入。
"""

from hypium import BY, UiDriver

from config import ACCOUNT_A, ACCOUNT_B, BUNDLE_NAME
from pages import (
    CheckPage,
    CartPage,
    GoodsPage,
    LoginPage,
    MinePage,
    SearchPage,
    SettingPage,
    TabBar,
)


class BaseCase:
    """所有测试类的基类，hypium 运行器会注入 self.device1。"""

    account_a = ACCOUNT_A
    account_b = ACCOUNT_B

    def setup(self):
        self.driver: UiDriver = UiDriver(self.device1)
        self.driver.start_app(BUNDLE_NAME)
        self.driver.wait_for_component(TabBar.HOME, timeout=10)
        self.ensure_logged_out()

    def teardown(self):
        # 回到首页 Tab，保证用例独立性
        try:
            self.driver.find_component(TabBar.HOME).click()
        except Exception:
            self.driver.go_home()

    # ---------- 通用业务动作 ----------

    def login(self, username: str, password: str):
        """通过 我的 Tab → 立即登录 进入登录页（对应 LoginView）。"""
        self.driver.find_component(TabBar.MINE).click()
        self.driver.find_component(MinePage.LOGIN_ENTRY).click()
        self.driver.input_text(LoginPage.ACCOUNT_INPUT, username)
        self.driver.input_text(LoginPage.PASSWORD_INPUT, password)
        self.driver.find_component(LoginPage.LOGIN_BTN).click()
        # 登录成功后 LoginView 会 pop 回 MineView
        self.driver.wait_for_component(MinePage.EDIT_PROFILE, timeout=10)

    def ensure_logged_out(self):
        """Normalize the session before a test instead of relying on test order."""
        self.driver.find_component(TabBar.MINE).click()
        if self.driver.is_component_exist(MinePage.EDIT_PROFILE):
            self.logout()
        else:
            self.driver.find_component(TabBar.HOME).click()

    def logout(self):
        """我的 → 设置（accessibilityText='设置'）→ 退出登录 → 确认弹窗'确定'。"""
        self.driver.find_component(TabBar.MINE).click()
        self.driver.find_component(MinePage.SETTINGS_ICON).click()
        self.driver.find_component(SettingPage.LOGOUT_CELL).click()
        self.driver.find_component(SettingPage.CONFIRM_BTN).click()
        self.driver.wait_for_component(MinePage.LOGIN_ENTRY, timeout=10)

    def search(self, keyword: str):
        """首页搜索框进入 SearchView 并触发搜索。

        注意：SearchView 对空关键词 trim 后直接 return，不跳转结果页。
        """
        self.driver.find_component(SearchPage.SEARCH_BOX).click()
        self.driver.input_text(SearchPage.SEARCH_BOX, keyword)
        self.driver.find_component(SearchPage.SEARCH_BTN).click()

    def open_goods_detail(self, goods_text: str):
        """搜索并进入商品详情（GoodsView）。"""
        self.search(goods_text)
        self.driver.find_component(BY.text(goods_text)).click()

    def add_goods_to_cart(self, goods_text: str):
        """搜索 → 详情 → 点'加入购物袋'打开半模态 → 确认加入。"""
        self.open_goods_detail(goods_text)
        self.driver.find_component(GoodsPage.ADD_CART_BTN).click()
        # 半模态弹层里的"加入购物袋"按钮（第二个同名按钮）
        self.driver.find_component(GoodsPage.ADD_CART_BTN).click()
        self.driver.assert_component_exist(BY.text(GoodsPage.TOAST_ADD_SUCCESS))

    def collect_current_goods(self):
        """详情页点击收藏（accessibilityText='收藏商品'）。"""
        self.driver.find_component(GoodsPage.COLLECT_BTN).click()
        self.driver.assert_component_exist(BY.text(GoodsPage.TOAST_COLLECT_OK))

    def goto_cart(self):
        self.driver.find_component(TabBar.CART).click()

    def open_favorites(self):
        self.driver.find_component(TabBar.MINE).click()
        self.driver.find_component(MinePage.FAVORITES).click()

    def open_history(self):
        self.driver.find_component(TabBar.MINE).click()
        self.driver.find_component(MinePage.HISTORY).click()

    def open_orders_unpaid(self):
        self.driver.find_component(TabBar.MINE).click()
        self.driver.find_component(MinePage.ORDERS_UNPAID).click()
        self.driver.wait_for_component(CheckPage.NO_ADDRESS_TIP if False else OrderPageTab.TAB_UNPAID, timeout=10)

    def settle_and_pay(self):
        """购物袋勾选 → 去结算 → 提交订单 → 立即支付（CheckView → PayView → PayResultView）。"""
        self.goto_cart()
        self.driver.find_component(CartPage.SETTLE_BTN).click()
        self.driver.find_component(CheckPage.SUBMIT_ORDER_BTN).click()
        self.driver.find_component(CheckPage.PAY_NOW_BTN).click()


class OrderPageTab:
    """OrderView 的状态 Tab（与 pages.OrderPage 对应，供基类内部引用）。"""

    TAB_UNPAID = BY.text("待付款")
