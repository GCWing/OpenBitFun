import { describe, expect, it } from 'vitest';
import { coordinate, pinEmoji } from './mapUtils';

describe('OpenUI map value normalization', () => {
  it('accepts provider coordinates with string values and lon aliases', () => {
    expect(coordinate({ lat: '31.2304', lon: '121.4737' })).toEqual([31.2304, 121.4737]);
    expect(coordinate({ lat: 31.2304, longitude: 121.4737 })).toEqual([31.2304, 121.4737]);
  });

  it('rejects invalid or out-of-range provider coordinates', () => {
    expect(coordinate({ lat: 'not-a-number', lng: 121.4 })).toBeNull();
    expect(coordinate({ lat: 91, lng: 121.4 })).toBeNull();
    expect(coordinate({ lat: 31.2, lng: 181 })).toBeNull();
  });

  it('keeps an emoji grapheme intact for marker pins', () => {
    expect(pinEmoji('👨‍👩‍👧‍👦 family')).toBe('👨‍👩‍👧‍👦');
    expect(pinEmoji('Museum')).toBeNull();
  });
});
