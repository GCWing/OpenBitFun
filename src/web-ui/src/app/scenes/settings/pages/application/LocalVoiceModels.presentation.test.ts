import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    'utf8',
  );
}

describe('Voice settings page structure', () => {
  it('opens compact local model management from the voice status instead of inline', () => {
    const voiceSource = readSource(
      './VoiceSettingsSection.tsx',
    );
    const dialogSource = readSource(
      '../../../../../infrastructure/config/components/LocalVoiceModelsConfig.tsx',
    );

    expect(voiceSource).toContain('setLocalModelsOpen(true)');
    expect(voiceSource).toContain('isOpen={localModelsOpen}');
    expect(voiceSource).not.toContain('local-models-anchor');
    expect(dialogSource).toContain('<Dialog');
    expect(dialogSource).not.toContain('<ConfigPageSection');
    expect(dialogSource).not.toContain('{model.provider}');
    expect(dialogSource).not.toContain('{model.version}');
    expect(dialogSource).not.toContain('{model.description}');
  });
});
