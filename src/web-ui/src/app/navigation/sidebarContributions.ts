import { createSidebarRegistry, type SidebarContribution, type SidebarContext } from './sidebarRegistry';
import type { ProductActionId } from '@/app/global-search/productActionCatalog';
import type { SceneTabId } from '@/app/components/SceneBar/types';

const localDesktopOnly = (context: SidebarContext) => context.isDesktop && !context.isPeer
  ? null : 'common:nav.customization.localDesktopOnly' as const;

function productPage(
  id: string, labelKey: SidebarContribution['labelKey'], icon: SidebarContribution['icon'],
  sceneId: SceneTabId, actionId: ProductActionId,
): SidebarContribution {
  return {
    id, labelKey, icon,
    isActive: context => context.activeSceneId === sceneId,
    open: async scope => {
      const { activateProductAction } = await import('@/app/global-search/productActionActivator');
      if (scope.isCurrent()) await activateProductAction(actionId);
    },
  };
}

function skillsPage(tab: 'installed' | 'discover'): SidebarContribution {
  return {
    id: `builtin.skills.${tab}`,
    labelKey: tab === 'installed' ? 'common:nav.items.skills' : 'common:nav.items.discoverSkills',
    icon: tab === 'installed' ? 'book-open' : 'search',
    isActive: context => context.activeSceneId === 'skills' && context.skillsTab === tab,
    unavailableReason: localDesktopOnly,
    open: async scope => {
      const [{ useSkillsSceneStore }, { useSceneStore }] = await Promise.all([
        import('@/app/scenes/skills/skillsSceneStore'), import('@/app/stores/sceneStore'),
      ]);
      if (!scope.isCurrent()) return;
      useSkillsSceneStore.getState().openNativeSkills(tab);
      useSceneStore.getState().openScene('skills');
    },
  };
}

export const sidebarRegistry = createSidebarRegistry([
  productPage('builtin.todos', 'common:nav.items.todos', 'clock', 'todos', 'surface.todos.open'),
  {
    id: 'builtin.agents', labelKey: 'common:nav.items.agents', icon: 'users',
    isActive: context => context.activeSceneId === 'agents',
    open: async scope => {
      const [{ useAgentsStore }, { useSceneStore }] = await Promise.all([
        import('@/app/scenes/agents/agentsStore'), import('@/app/stores/sceneStore'),
      ]);
      if (!scope.isCurrent()) return;
      const agents = useAgentsStore.getState();
      agents.openHome();
      agents.setSearchQuery('');
      agents.setAgentFilterLevel('all');
      agents.setAgentFilterType('all');
      useSceneStore.getState().openScene('agents');
    },
  },
  {
    id: 'builtin.assistants', labelKey: 'shared:agents.Claw', icon: 'message-square',
    isActive: context => context.activeSceneId === 'assistant' || context.activeSceneId === 'profile',
    open: async scope => {
      const [{ useNurseryStore }, { useSceneStore }] = await Promise.all([
        import('@/app/scenes/profile/nurseryStore'), import('@/app/stores/sceneStore'),
      ]);
      if (!scope.isCurrent()) return;
      useNurseryStore.getState().openGallery();
      useSceneStore.getState().openScene('assistant');
    },
  },
  productPage('builtin.miniapps', 'common:nav.items.miniApps', 'mini-app', 'miniapps', 'surface.miniapps.open'),
  skillsPage('installed'),
  skillsPage('discover'),
  productPage('builtin.insights', 'common:scenes.insights', 'chart-spline', 'insights', 'surface.insights.open'),
]);
