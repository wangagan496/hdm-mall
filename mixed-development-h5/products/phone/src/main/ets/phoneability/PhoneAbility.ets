import { AbilityConstant, ConfigurationConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { auth, localGoodsStore, storeManager } from 'storage';
import { screenManager, screenManagerByMedia } from 'utils';
import { GlobalVariable } from 'constants';

const DOMAIN = 0x0000;

export default class PhoneAbility extends UIAbility {
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
    screenManager.full(this.context)
    storeManager.ctx = this.context
    // 将 context 存入 AppStorage，供 network 模块的 toast 使用（避免循环依赖）
    AppStorage.setOrCreate(GlobalVariable.ABILITY_CONTEXT_KEY, this.context)
    this.restoreUserSession()
    // Main window is created, set main page for this ability
    hilog.info(0x0000, 'testTag', '%{public}s', 'Ability onWindowStageCreate');
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(0x0000, 'testTag', 'Failed to load the content. Cause: %{public}s', JSON.stringify(err) ?? '');
        return;
      }
      screenManagerByMedia.registerListenerScreen(this.context)
      hilog.info(0x0000, 'testTag', 'Succeeded in loading the content.');
    });
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
