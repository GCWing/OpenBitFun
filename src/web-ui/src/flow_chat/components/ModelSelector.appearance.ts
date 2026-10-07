import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const modelSelectorAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'model-selector',
  parts: [
    { id: 'root' },
    { id: 'trigger' },
    { id: 'name' },
    { id: 'selectionSummary' },
    { id: 'modeMaterial' },
    { id: 'modeChoices' },
    { id: 'reasoningSummary' },
    { id: 'reasoningSlider' },
    { id: 'reasoningSliderSky' },
    { id: 'reasoningSliderNebula' },
    { id: 'reasoningSliderAurora' },
    { id: 'reasoningSliderInput' },
    { id: 'reasoningSliderValue' },
    { id: 'dropdown' },
    { id: 'loading' },
    { id: 'level' },
    { id: 'back' },
    { id: 'list' },
    { id: 'option' },
    { id: 'providerOption' },
    { id: 'optionMain' },
  ],
  states: [
    { id: 'open', selector: { kind: 'self', suffix: '[data-openbitfun-state~="open"]' } },
    { id: 'loading', selector: { kind: 'self', suffix: '[data-openbitfun-state~="loading"]' } },
    { id: 'selected', selector: { kind: 'self', suffix: '[data-openbitfun-state~="selected"]' } },
  ],
};
