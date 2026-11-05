import type { AgentCompanionPetSelection } from './AIExperienceConfigService';

export const LIVING_LINE_PET: AgentCompanionPetSelection = {
  id: 'living-line',
  displayName: 'LivingLine',
  description: 'An original animated line companion with expressive activity states.',
  source: 'preset',
  packagePath: '/agent-companion-pets/living-line',
  spritesheetPath: '/agent-companion-pets/living-line/preview.svg',
  spritesheetMimeType: 'image/svg+xml',
};

export function isLivingLinePet(pet: AgentCompanionPetSelection | null | undefined): boolean {
  return pet?.source === 'preset' && pet.id === LIVING_LINE_PET.id
    && pet.packagePath === LIVING_LINE_PET.packagePath;
}
