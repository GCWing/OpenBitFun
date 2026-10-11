import { hapTasks } from '@ohos/hvigor-ohos-plugin';

// Include the current shared sources on every IDE and CLI build.
require('../miniapps/generate.cjs').generate();
// Regenerate the HostTextRetranslator i18n rawfile catalog on every build.
require('../i18n/generate.cjs').generate();

export default {
  system: hapTasks, /* Built-in plugin of Hvigor. It cannot be modified. */
  plugins: []       /* Custom plugin to extend the functionality of Hvigor. */
}