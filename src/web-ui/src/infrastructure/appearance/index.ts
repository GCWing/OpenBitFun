import { createDefaultAppearanceRegistry } from './registry/defaultAppearanceRegistry';
import { AppearancePackageParser } from './schema/AppearancePackageParser';
import { createAppearanceStorage } from './storage/AppearanceStorage';
import { AppearanceRuntime } from './runtime/AppearanceRuntime';
import { AppearanceService } from './runtime/AppearanceService';
import { createAppearanceSyncPort } from './sync/AppearanceSync';

export * from './types';
export * from './schema/AppearancePackageValidator';
export * from './schema/AppearancePackageValidationError';
export * from './schema/AppearancePackageParser';
export * from './compiler/AppearanceCompiler';
export * from './runtime/AppearanceRuntime';
export * from './runtime/AppearanceService';
export * from './runtime/AppearanceOverlayHost';
export * from './runtime/AppearanceBackgroundMedia';
export * from './registry/AppearanceRegistry';
export * from './registry/defaultAppearanceRegistry';
export * from './storage/AppearanceStorage';
export * from './sync/AppearanceSync';
export * from './builtins/buildBuiltinAppearance';
export * from './builtins/catalog';
export * from './builtins/AppearancePalette';
export * from './builtins/palettes';
export * from './builtins/startupAppearanceBootstrap';
export * from './adapters/MonacoAppearanceAdapter';
export * from './adapters/XtermAppearanceAdapter';
export * from './appearanceDomainTokens';
export * from './appearancePropertyProfiles';
export * from './adapters/MermaidAppearanceAdapter';
export * from './adapters/WidgetAppearanceAdapter';
export * from './adapters/ThemeTokenAppearanceAdapter';
export * from './adapters/PluginAppearanceProjection';
export * from './hooks/useAppearance';

export const appearanceRegistry = createDefaultAppearanceRegistry();
export const appearanceRuntime = new AppearanceRuntime(appearanceRegistry);
export const appearanceStorage = createAppearanceStorage();
export const appearancePackageParser = new AppearancePackageParser(appearanceRegistry);
export const appearanceSyncPort = createAppearanceSyncPort();
export const appearanceService = new AppearanceService(
  appearanceRuntime,
  appearancePackageParser,
  appearanceStorage,
  appearanceSyncPort,
);
