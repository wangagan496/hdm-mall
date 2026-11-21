import { HvigorNode } from '@ohos/hvigor';
import { appTasks, OhosAppContext, OhosPluginId } from '@ohos/hvigor-ohos-plugin';
import { existsSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { resolve } from 'path';
import { resolveClientEnvironment } from './build-support/client-environment';

const localSigningProfilePath = './build-profile.local.json5';
// 每次构建从真实工程配置和唯一Zod来源刷新生成文件，漂移不能藏进签名包。
execFileSync(process.execPath, [resolve('../scripts/generate-module-structure.mjs')], { stdio: 'pipe' });
execFileSync(process.execPath, [resolve('../contract-kit/v1/generators/generate.ts')], { stdio: 'pipe' });
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
