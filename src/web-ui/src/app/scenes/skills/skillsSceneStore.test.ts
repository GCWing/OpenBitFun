import { beforeEach, describe, expect, it } from 'vitest';
import { useSkillsSceneStore } from './skillsSceneStore';

beforeEach(() => {
  useSkillsSceneStore.setState(useSkillsSceneStore.getInitialState(), true);
});

describe('Skills entry navigation', () => {
  it('opens discovery without carrying over a previous market search', () => {
    useSkillsSceneStore.setState({ searchDraft: 'old query', marketQuery: 'old query' });
    useSkillsSceneStore.getState().openNativeSkills('discover');
    expect(useSkillsSceneStore.getState()).toMatchObject({
      nativeNavigationTarget: 'discover',
      nativeNavigationRequest: 1,
      searchDraft: '',
      marketQuery: '',
    });
  });

  it('keeps existing callers on the installed collection and restores all skills', () => {
    useSkillsSceneStore.getState().openNativeSkills('discover');
    useSkillsSceneStore.setState({ installedView: 'groups' });
    useSkillsSceneStore.getState().openNativeSkills();
    expect(useSkillsSceneStore.getState()).toMatchObject({
      nativeNavigationTarget: 'installed',
      nativeNavigationRequest: 2,
      installedView: 'all',
    });
  });

  it('issues a fresh navigation request when returning to the same destination', () => {
    useSkillsSceneStore.getState().openNativeSkills('discover');
    useSkillsSceneStore.getState().setSearchDraft('new query');
    useSkillsSceneStore.getState().submitMarketQuery();
    useSkillsSceneStore.getState().openNativeSkills('discover');
    expect(useSkillsSceneStore.getState()).toMatchObject({
      nativeNavigationTarget: 'discover',
      nativeNavigationRequest: 2,
      searchDraft: '',
      marketQuery: '',
    });
  });
});
