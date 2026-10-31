import type { ComponentMeta } from '../../registry.types';

export const colorPickerMeta = {
  name: 'ColorPicker', category: 'form', maturity: 'stable',
  description: 'An editable HEX pill and expandable flower palette with a curved lightness slider.',
  props: [
    { name: 'value', type: 'string' }, { name: 'defaultValue', type: 'string' }, { name: 'onValueChange', type: '(value: string) => void' },
    { name: 'open', type: 'boolean' }, { name: 'defaultOpen', type: 'boolean', defaultValue: 'false' },
    { name: 'onOpenChange', type: '(open: boolean) => void' }, { name: 'disabled', type: 'boolean', defaultValue: 'false' },
    { name: 'labels', type: 'Partial<ColorPickerLabels>' },
  ],
  states: ['collapsed', 'expanded', 'invalid', 'disabled'],
  tokens: ['color.surface.panel', 'color.content.primary', 'color.field.background', 'color.focus.ring', 'control.height.lg', 'radius.pill', 'shadow.sm', 'shadow.base', 'motion.duration.normal', 'type.code.md.fontFamily'],
} as const satisfies ComponentMeta;
