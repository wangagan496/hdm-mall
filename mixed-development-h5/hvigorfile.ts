import { appTasks } from '@ohos/hvigor-ohos-plugin';
import { existsSync, readFileSync } from 'fs';

const localSigningProfilePath = './build-profile.local.json5';
const localSigningOverrides = existsSync(localSigningProfilePath)
  ? JSON.parse(readFileSync(localSigningProfilePath, 'utf8'))
  : {};

export default {
  system: appTasks, /* Built-in plugin of Hvigor. It cannot be modified. */
  plugins: [],      /* Custom plugin to extend the functionality of Hvigor. */
  config: {
    ohos: {
      overrides: localSigningOverrides
    }
  }
}
