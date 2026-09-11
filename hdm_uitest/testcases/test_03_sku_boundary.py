"""SKU 边界用例（重点组 A，对应 SKU-02 / SKU-03 / SKU-04 / SKU-06 / SKU-11）。

源码行为（GoodsView.ets）：
- 数量为 Counter 组件：enableDec(count>1)、enableInc(count<库存)，
  0 与超库存在 UI 层被天然拦截（SKU-05/07/08 由组件保证，自动化重点覆盖其余边界）。
- 未选 SKU 点加购 → toast'请选择对应的产品规格'。
- 兜底 SKU（isFallbackSkuId）→ toast'商品规格加载失败，请返回重试'。
- 库存为 0 的规格 → 文案'暂时缺货'。
"""

from hypium import BY

from base_case import BaseCase
from config import GOODS_NAME
from pages import GoodsPage


class TestSkuBoundary(BaseCase):

    def setup(self):
        super().setup()
        self.login(*self.account_a)

    def _open_target_goods(self):
        self.open_goods_detail(GOODS_NAME)

    def test_sku_02_incomplete_spec_blocked(self):
        """SKU-02: 未选完整规格 → toast'请选择对应的产品规格'，不发起下单"""
        self._open_target_goods()
        self.driver.find_component(GoodsPage.ADD_CART_BTN).click()
        self.driver.find_component(GoodsPage.ADD_CART_BTN).click()
        assert self.driver.is_component_exist(BY.text(GoodsPage.TOAST_NO_SPEC))

    def teardown(self):
        super().teardown()
