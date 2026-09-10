import { AbilityConstant, ConfigurationConstant, UIAbility, Want, bundleManager } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { auth, localGoodsStore, storeManager } from 'storage';
import { screenManager, screenManagerByMedia, LaunchPerf } from 'utils';
import { GlobalVariable } from 'constants';
import { HomePrefetch } from 'home';
import { loginAPI, LoginParams } from 'mine';

const DOMAIN = 0x0000;

export default class PhoneAbility extends UIAbility {
  private debugLaunchWant: Want = {} as Want
  private restoreUserSession(): void {
    try {
      const userInfo = storeManager.getUserInfo()
      if (userInfo?.token) {
        auth.setUserInfo(userInfo)
        localGoodsStore.migrateLegacyData().catch((error: Error) => {
          hilog.error(DOMAIN, 'LocalGoodsStore', 'Failed to migrate legacy local goods. Cause: %{public}s',
            JSON.stringify(error) ?? '')
        })
      } else {
        auth.clearUserInfo()
      }
    } catch (error) {
      auth.clearUserInfo()
      hilog.error(DOMAIN, 'UserSession', 'Failed to restore user session. Cause: %{public}s',
        JSON.stringify(error) ?? '')
    }
  }

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    LaunchPerf.mark('abilityOnCreate')
    this.debugLaunchWant = want
    // 冷启动关键路径：首屏请求在 onCreate 发出，与 HSP 加载和 UI 构建并行。
    HomePrefetch.start()
    try {
      this.context.getApplicationContext().setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET);
    } catch (err) {
      hilog.error(DOMAIN, 'testTag', 'Failed to set colorMode. Cause: %{public}s', JSON.stringify(err));
    }
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onCreate');
  }

  onDestroy(): void {
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onDestroy');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    LaunchPerf.mark('onWindowStageCreate')
    screenManager.full(this.context)
    storeManager.ctx = this.context
    // 将 context 存入 AppStorage，供 network 模块的 toast 使用（避免循环依赖）
    AppStorage.setOrCreate(GlobalVariable.ABILITY_CONTEXT_KEY, this.context)
    this.restoreUserSession()
    this.injectDebugTestAccount()
    // Main window is created, set main page for this ability
    hilog.info(0x0000, 'testTag', '%{public}s', 'Ability onWindowStageCreate');
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(0x0000, 'testTag', 'Failed to load the content. Cause: %{public}s', JSON.stringify(err) ?? '');
        return;
      }
      LaunchPerf.mark('indexLoaded')
      screenManagerByMedia.registerListenerScreen(this.context)
      hilog.info(0x0000, 'testTag', 'Succeeded in loading the content.');
    });
  }

  // Debug-only verification hook: pass account/password through Want so the normal login API is exercised.
  // 仅 debug 构建生效，release 包不暴露该测试入口。
  private injectDebugTestAccount(): void {
    if (!this.isDebuggable()) {
      return
    }
    const parameters: Record<string, Object> = this.debugLaunchWant.parameters as Record<string, Object>
    const account = parameters['debugTestAccount']?.toString() ?? ''
    const password = parameters['debugTestPassword']?.toString() ?? ''
    if (!account || !password) {
      return
    }
    const loginParams: LoginParams = { account, password }
    loginAPI(loginParams).then(async (user) => {
      await storeManager.setUserInfo(user)
      auth.setUserInfo(user)
      hilog.info(DOMAIN, 'DebugLogin', 'Want test account login succeeded')
    }).catch(() => {
      hilog.error(DOMAIN, 'DebugLogin', 'Want test account login failed')
    })
  }

  private isDebuggable(): boolean {
    try {
      const bundleInfo = bundleManager.getBundleInfoForSelfSync(
        bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION)
      return bundleInfo.appInfo.debug === true
    } catch {
      return false
    }
  }

  onWindowStageDestroy(): void {
    screenManagerByMedia.unregisterListenerScreen(this.context)
    // Main window is destroyed, release UI related resources
    hilog.info(0x0000, 'testTag', '%{public}s', 'Ability onWindowStageDestroy');
  }

  onForeground(): void {
    // Ability has brought to foreground
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onForeground');
  }

  onBackground(): void {
    // Ability has back to background
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onBackground');
  }
}
