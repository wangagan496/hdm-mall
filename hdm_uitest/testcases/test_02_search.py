"""搜索用例（对应 TC-004 / TC-005，导图搜索测试点精选）。

源码行为（SearchView.ets）：空关键词 trim 后直接 return，不跳转结果页。
"""

from hypium import BY

from base_case import BaseCase
from config import GOODS_NAME, KEYWORD_HIT, KEYWORD_PINYIN
from pages import SearchPage


class TestSearch(BaseCase):

    def test_tc_004_search_chinese_hit(self):
        """TC-004: 汉字搜索 → 命中商品并按 UI 效果展示"""
        self.search(KEYWORD_HIT)
        assert self.driver.is_component_exist(BY.text(GOODS_NAME))

    def test_search_pinyin(self):
        """导图: 拼音搜索 yagao → 命中牙膏商品（服务端分词能力）"""
        self.search(KEYWORD_PINYIN)
        assert self.driver.is_component_exist(BY.text(GOODS_NAME))

    def test_tc_005_search_empty_stays(self):
        """TC-005: 空关键词 → SearchView 直接 return，不跳转结果页"""
        self.driver.find_component(SearchPage.SEARCH_BOX).click()
        self.driver.find_component(SearchPage.SEARCH_BTN).click()
        # 仍停留在搜索页（搜索框仍在），未进入结果页
        assert self.driver.is_component_exist(SearchPage.SEARCH_BOX)
