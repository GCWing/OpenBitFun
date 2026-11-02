import type { TokenName } from "./index.js";

export type FontFamilyTokenName = Extract<TokenName, `font.family.${string}` | `type.${string}.fontFamily`>;
export type FontSizeTokenName = Extract<TokenName, `font.size.${string}` | `type.${string}.fontSize`>;
export type FontWeightTokenName = Extract<TokenName, `font.weight.${string}` | `type.${string}.fontWeight`>;
export type LineHeightTokenName = Extract<TokenName, `lineHeight.${string}` | `type.${string}.lineHeight`>;
export type LetterSpacingTokenName = Extract<TokenName, `letterSpacing.${string}` | `type.${string}.letterSpacing`>;
export type TypographyTokenName = FontFamilyTokenName | FontSizeTokenName | FontWeightTokenName | LineHeightTokenName | LetterSpacingTokenName;

export declare function getTypographyTokenValue(name: TypographyTokenName): string;
export declare function getTypographyTokenPx(name: FontSizeTokenName): number;
export declare function getTypographyTokenNumber(name: FontWeightTokenName | LineHeightTokenName | LetterSpacingTokenName): number;
export declare function readActiveTypographyTokenValue(name: TypographyTokenName, target?: Element | null): string;
export declare function readActiveTypographyTokenPx(name: FontSizeTokenName, target?: Element | null): number;
export declare function readActiveTypographyTokenNumber(name: FontWeightTokenName | LineHeightTokenName | LetterSpacingTokenName, target?: Element | null): number;

export type TypographySizeName =
  | "4xs"
  | "3xs"
  | "2xs"
  | "micro"
  | "meta"
  | "xs"
  | "sm"
  | "base"
  | "lg"
  | "xl"
  | "2xl"
  | "3xl"
  | "4xl"
  | "5xl"
  | "6xl"
  | "7xl"
  | "8xl"
  | "9xl";

export type TypographySizeScale = Readonly<Record<TypographySizeName, `${number}px`>>;

export declare const TYPOGRAPHY_BASE_MIN_PX = 12;
export declare const TYPOGRAPHY_BASE_MAX_PX = 20;
export declare const TYPOGRAPHY_SIZE_OFFSETS: Readonly<Record<TypographySizeName, number>>;
export declare function createTypographySizeScale(basePx: number): TypographySizeScale;
