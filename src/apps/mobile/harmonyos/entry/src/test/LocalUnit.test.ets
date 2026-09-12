import miniAppUnitTest from './MiniAppUnit.test';
import transportAndGeneralChatUnitTest from './TransportAndGeneralChatUnit.test';
import conversationStateUnitTest from './ConversationStateUnit.test';
import conversationPresentationUnitTest from './ConversationPresentationUnit.test';
import lifecycleUnitTest from './LifecycleUnit.test';
import appRootLifecycleUnitTest from './AppRootLifecycleUnit.test';
import remoteControllersUnitTest from './RemoteControllersUnit.test';
import appRootRuntimeStartupUnitTest from './AppRootRuntimeStartupUnit.test';
import deviceDirectoryUnitTest from './DeviceDirectoryUnit.test';
import architectureUnitTest from './ArchitectureUnit.test';
import i18nUnitTest from './I18nUnit.test';
import watchProvisionUnitTest from './WatchProvisionUnit.test';

export default function localUnitTest() {
  miniAppUnitTest();
  i18nUnitTest();
  watchProvisionUnitTest();
  architectureUnitTest();
  transportAndGeneralChatUnitTest();
  conversationStateUnitTest();
  conversationPresentationUnitTest();
  lifecycleUnitTest();
  appRootLifecycleUnitTest();
  remoteControllersUnitTest();
  appRootRuntimeStartupUnitTest();
  deviceDirectoryUnitTest();
}
