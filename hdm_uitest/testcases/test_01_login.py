"""登录用例（对应 TC-001 / TC-002，文案取自 LoginView.ets 源码）。"""

from hypium import BY

from base_case import BaseCase
from pages import LoginPage, MinePage


class TestLogin(BaseCase):

    def test_tc_001_login_success(self):
        """TC-001: 正常登录 → toast'登录成功'，我的页显示'编辑资料'"""
        self.login(*self.account_a)
        assert self.driver.is_component_exist(MinePage.EDIT_PROFILE)

    def test_tc_002_login_fail_toast(self):
        """TC-002: 登录失败 → toast'登录失败，请稍后重试'，仍停留在登录页"""
        username, _ = self.account_a
        self.driver.find_component(BY.text("我的")).click()
        self.driver.find_component(MinePage.LOGIN_ENTRY).click()
        self.driver.input_text(LoginPage.ACCOUNT_INPUT, username)
        self.driver.input_text(LoginPage.PASSWORD_INPUT, "wrong_password")
        self.driver.find_component(LoginPage.LOGIN_BTN).click()
        assert self.driver.is_component_exist(BY.text("登录失败，请稍后重试"))

    def test_tc_002b_agreement_required(self):
        """导图补充: 未勾选协议 → toast'请先勾选协议'（LoginView.onSubmit 拦截）"""
        self.driver.find_component(BY.text("我的")).click()
        self.driver.find_component(MinePage.LOGIN_ENTRY).click()
        self.driver.input_text(LoginPage.ACCOUNT_INPUT, self.account_a[0])
        self.driver.input_text(LoginPage.PASSWORD_INPUT, self.account_a[1])
        # 不勾选协议直接提交：LoginView 的登录按钮 enabled 依赖账号密码非空，
        # 协议拦截在 onSubmit 内部，需要先输入完成使按钮可用
        self.driver.find_component(LoginPage.LOGIN_BTN).click()
        assert self.driver.is_component_exist(BY.text("请先勾选协议"))
