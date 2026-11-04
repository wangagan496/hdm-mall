import { HvigorNode } from '@ohos/hvigor';
import { appTasks, OhosAppContext, OhosPluginId } from '@ohos/hvigor-ohos-plugin';
import { existsSync, readFileSync } from 'fs';
import { resolveClientEnvironment } from './build-support/client-environment';

const localSigningProfilePath = './build-profile.local.json5';
const localSigningOverrides = existsSync(localSigningProfilePath)
  ? JSON.parse(readFileSync(localSigningProfilePath, 'utf8'))
  : {};

export default {
  system: appTasks, /* Built-in plugin of Hvigor. It cannot be modified. */
  plugins: [{
    pluginId: 'hdm-client-environment',
    apply(node: HvigorNode) {
      node.afterNodeEvaluate(() => {
        const context = node.getContext(OhosPluginId.OHOS_APP_PLUGIN) as OhosAppContext;
        const fields = resolveClientEnvironment(context.getBuildMode(), process.env);
        const profile = context.getBuildProfileOpt();
        const product = profile.app.products?.find(item => item.name === context.getCurrentProduct().getProductName());
        if (!product) throw new Error('Current build product was not found');
        product.buildOption ??= {};
        product.buildOption.arkOptions ??= {};
        product.buildOption.arkOptions.buildProfileFields = {
          ...product.buildOption.arkOptions.buildProfileFields, ...fields
        };
        context.setBuildProfileOpt(profile);
      });
    }
  }],
  config: {
    ohos: {
      overrides: localSigningOverrides
    }
  }
}
