"""购物袋 → 结算 → 支付主流程用例（对应 TC-007 / TC-008 / TC-010 / TC-011）。

源码行为：
- CartView: 未勾选商品点'去结算' → toast'请选择要结算的商品'。
- CheckView: '提交订单' → '立即支付'，提交失败 toast'提交订单失败，请稍后重试'。
- PayView: 支付为 ArkWeb 加载的 H5 收银台（alipay wap），
  自动化在此断言跳转到'支付'页；'付款成功/付款失败'结果断言需真实支付环境，标记手动。
"""

from hypium import BY

from base_case import BaseCase
from config import GOODS_NAME, TOAST_SETTLE_NO_SELECT
from pages import CartPage


class TestCartPay(BaseCase):

    def setup(self):
        super().setup()
        self.login(*self.account_a)

    def test_tc_007_add_cart(self):
        """TC-007: 正常加购 → toast'加入购物车成功'，购物袋内商品可见"""
        self.add_goods_to_cart(GOODS_NAME)
        self.goto_cart()
        assert self.driver.is_component_exist(BY.text(GOODS_NAME))

    def test_tc_009_settle_without_selection_blocked(self):
        """TC-009 变体: 未勾选商品点'去结算' → toast'请选择要结算的商品'"""
        self.add_goods_to_cart(GOODS_NAME)
        self.goto_cart()
        if self.driver.is_component_exist(CartPage.CANCEL_ALL):
            self.driver.find_component(CartPage.CANCEL_ALL).click()
        self.driver.find_component(CartPage.SETTLE_BTN).click()
        assert self.driver.is_component_exist(BY.text(TOAST_SETTLE_NO_SELECT))

    def test_tc_010_submit_order_reach_pay(self):
        """TC-010: 提交订单 → 进入支付页；真实支付结果由手工验收。"""
        self.add_goods_to_cart(GOODS_NAME)
        self.settle_and_pay()
        assert self.driver.is_component_exist(BY.text("支付"))

    def teardown(self):
        super().teardown()
