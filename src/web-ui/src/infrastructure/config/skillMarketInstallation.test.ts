import { describe, expect, it } from 'vitest';
import type { SkillInfo, SkillMarketItem } from './types';
import { installedSkillMarketIds, isSkillMarketItemInstalled } from './skillMarketInstallation';

const installed = (installationSource?: string): SkillInfo => ({ name: 'eli5', installationSource } as SkillInfo);
const market = (source: string, name = 'eli5'): SkillMarketItem => ({ source, name, installId: `${source}@${name}` } as SkillMarketItem);

describe('skill marketplace installation identity', () => {
  it('recognizes the same repository artifact from a configured skills.sh API', () => {
    const ids = installedSkillMarketIds([installed('first/skills')]);
    expect(isSkillMarketItemInstalled({ ...market('first/skills'), installId: 'skills-sh:https://corp#first/skills@eli5' }, ids)).toBe(true);
    expect(isSkillMarketItemInstalled({ ...market('second/skills'), installId: 'skills-sh:https://corp#second/skills@eli5' }, ids)).toBe(false);
  });

  it('matches SkillHub provenance independently of display names and distinguishes registries', () => {
    const id = 'skillhub:https://skills.corp/hub#team--review';
    const ids = installedSkillMarketIds([{ name: 'review', installationSource: id } as SkillInfo]);
    expect(isSkillMarketItemInstalled({ installId: id, name: 'Code Review' } as SkillMarketItem, ids)).toBe(true);
    expect(isSkillMarketItemInstalled({ installId: 'skillhub:https://other.corp#team--review' } as SkillMarketItem, ids)).toBe(false);
    expect(isSkillMarketItemInstalled({ installId: id } as SkillMarketItem, installedSkillMarketIds([]))).toBe(false);
  });
  it('marks only the installed repository when several packages share a name', () => {
    const ids = installedSkillMarketIds([installed('first/skills')]);
    expect(['first/skills', 'second/skills', 'third/skills'].map(source => isSkillMarketItemInstalled(market(source), ids)))
      .toEqual([true, false, false]);
    expect(isSkillMarketItemInstalled(market('first/skills', 'another'), ids)).toBe(false);
  });
  it('does not infer provenance for legacy, builtin or manually copied names', () => {
    expect(isSkillMarketItemInstalled(market('first/skills'), installedSkillMarketIds([installed()]))).toBe(false);
  });
  it('matches repository URL aliases but preserves the package identity', () => {
    const ids = installedSkillMarketIds([installed('https://github.com/First/Skills.git/')]);
    expect(isSkillMarketItemInstalled(market('first/skills'), ids)).toBe(true);
    expect(isSkillMarketItemInstalled({ ...market('first/skills'), name: 'Display label' }, ids)).toBe(true);
  });
  it('follows refreshed installs after replacement, removal or workspace changes', () => {
    const first = market('first/skills');
    const second = market('second/skills');
    const ids = installedSkillMarketIds([installed('second/skills')]);
    expect(isSkillMarketItemInstalled(first, ids)).toBe(false);
    expect(isSkillMarketItemInstalled(second, ids)).toBe(true);
    expect(isSkillMarketItemInstalled(second, installedSkillMarketIds([]))).toBe(false);
  });
});
