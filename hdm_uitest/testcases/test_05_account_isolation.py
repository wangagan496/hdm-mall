"""多账号数据隔离用例（重点组 B，对应 ISO-02 / ISO-03 / ISO-04 / ISO-05 / ISO-06）。

源码依据（storage 模块）：
- localGoodsStore: 按登录账号隔离的本地收藏与浏览足迹（migrateLegacyData 迁移旧数据）。
- authCart: 按账号维度的购物车（updateCartCount）。
- 空态文案：收藏'还没有收藏商品'、足迹'还没有浏览足迹'、购物袋'购物车空空哒'/'您当前未登录'。
"""

from hypium import BY

from base_case import BaseCase
from config import GOODS_NAME
from pages import CartPage, FavoritesPage, HistoryPage


class TestAccountIsolation(BaseCase):

    def test_iso_04_cart_isolated_between_accounts(self):
        """ISO-04: A 加购后退出，B 登录购物袋不含 A 的商品"""
        self.login(*self.account_a)
        self.add_goods_to_cart(GOODS_NAME)
        self.logout()
        self.login(*self.account_b)
        self.goto_cart()
        assert not self.driver.is_component_exist(BY.text(GOODS_NAME))

    def test_iso_02_favorites_isolated_between_accounts(self):
        """ISO-02: A 收藏后退出，B 登录收藏列表不含 A 的收藏"""
        self.login(*self.account_a)
        self.open_goods_detail(GOODS_NAME)
        self.collect_current_goods()
        self.logout()
        self.login(*self.account_b)
        self.open_favorites()
        # B 的收藏为空态或不含该商品
        assert self.driver.is_component_exist(FavoritesPage.EMPTY_TIP) or \
            not self.driver.is_component_exist(BY.text(GOODS_NAME))

    def test_iso_03_history_isolated_between_accounts(self):
        """ISO-03: A 浏览后退出，B 登录足迹不含 A 的浏览记录"""
        self.login(*self.account_a)
        self.open_goods_detail(GOODS_NAME)
        self.logout()
        self.login(*self.account_b)
        self.open_history()
        assert self.driver.is_component_exist(HistoryPage.EMPTY_TIP) or \
            not self.driver.is_component_exist(BY.text(GOODS_NAME))

    def test_iso_05_not_logged_in_cart_empty(self):
        """ISO-05: 未登录打开购物袋 → '您当前未登录'空态，无残留数据"""
        self.ensure_logged_out()
        self.goto_cart()
        assert self.driver.is_component_exist(CartPage.NOT_LOGIN_TIP)

    def test_iso_06_data_kept_after_relogin(self):
        """ISO-06: A 重新登录后收藏仍保留（本地按账号持久化）"""
        self.login(*self.account_a)
        self.open_goods_detail(GOODS_NAME)
        self.collect_current_goods()
        self.logout()
        self.login(*self.account_a)
        self.open_favorites()
        assert self.driver.is_component_exist(BY.text(GOODS_NAME))

    def test_iso_07_rapid_switch_no_cross_write(self):
        """ISO-07: A 登录→立即退出→立即登录 B（快速切换）→ B 数据无 A 残留"""
        self.login(*self.account_a)
        self.add_goods_to_cart(GOODS_NAME)
        # 快速连续切换，不做任何等待缓冲
        self.logout()
        self.login(*self.account_b)
        self.goto_cart()
        assert not self.driver.is_component_exist(BY.text(GOODS_NAME))

    def teardown(self):
        super().teardown()
