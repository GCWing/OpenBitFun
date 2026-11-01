import type { AgentCompanionPetSelection } from './AIExperienceConfigService';

export function isGrokLivePet(pet: AgentCompanionPetSelection | null | undefined): boolean {
  return pet?.source === 'preset' && pet.id === 'grok-live'
    && pet.packagePath === '/agent-companion-pets/grok-live';
}
