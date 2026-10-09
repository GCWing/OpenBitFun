import { hashSubagentIdentity } from './identityHash';

// Do not reorder or grow this versioned pool: restored sessions must retain
// their identities in every locale.
export const SUBAGENT_NAME_KEYS = [
  'subagentIdentity.names.bouncyBean',
  'subagentIdentity.names.cheekyBao',
  'subagentIdentity.names.sneakyMochi',
  'subagentIdentity.names.zoomingPotato',
  'subagentIdentity.names.curiousOtter',
  'subagentIdentity.names.discoPenguin',
  'subagentIdentity.names.noodleNinja',
  'subagentIdentity.names.bubbleBandit',
  'subagentIdentity.names.sleepyTaco',
  'subagentIdentity.names.pixelRascal',
  'subagentIdentity.names.jellyRocket',
  'subagentIdentity.names.wobblyPudding',
  'subagentIdentity.names.waffleWizard',
  'subagentIdentity.names.sneezingDragon',
  'subagentIdentity.names.giggleFox',
  'subagentIdentity.names.turboSnail',
  'subagentIdentity.names.marshmallowPirate',
  'subagentIdentity.names.pogoPanda',
  'subagentIdentity.names.toastDetective',
  'subagentIdentity.names.zigzagDuck',
  'subagentIdentity.names.mangoGoblin',
  'subagentIdentity.names.biscuitBandit',
  'subagentIdentity.names.cometHamster',
  'subagentIdentity.names.captainDucky',
  'subagentIdentity.names.hiccupSeal',
  'subagentIdentity.names.popcornImp',
  'subagentIdentity.names.wobbleCorgi',
  'subagentIdentity.names.ninjaPeach',
  'subagentIdentity.names.cloudHopper',
  'subagentIdentity.names.moonBunny',
] as const;

export function resolveSubagentNameKey(identity: string): typeof SUBAGENT_NAME_KEYS[number] {
  const seed = identity.trim();
  if (!seed) return SUBAGENT_NAME_KEYS[0];
  return SUBAGENT_NAME_KEYS[hashSubagentIdentity(`subagent-names-v1:${seed}`) % SUBAGENT_NAME_KEYS.length];
}
