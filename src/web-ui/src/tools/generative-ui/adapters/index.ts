import { oiComponents } from '../components/oiComponents';
import { openbitfunComponents } from '../components/openbitfunComponents';
import { openUILibrary } from '../components/openuiLibrary';
import { functions } from '../genUIPrimitives';
import type { GenUIImplementations, GenUIRendererSource } from '../genUILibrary';

const sourcesFor = (
  components: Record<string, unknown>,
  source: GenUIRendererSource,
): Record<string, GenUIRendererSource> => Object.fromEntries(
  Object.keys(components).map(name => [name, source]),
);

// Keep the OpenUI component contract stable while mounting OpenBitFun's product
// controls for the composable profile. Data visualizations and other GenUI
// primitives remain owned by oiComponents below.
const openbitfunAdapterComponents = { ...oiComponents, ...openbitfunComponents };
const openbitfunRendererSources: Record<string, GenUIRendererSource> = sourcesFor(oiComponents, {
  kind: 'openui-react',
  source: 'open-intelligent-ui component contract adapter',
});
Object.assign(openbitfunRendererSources, sourcesFor(openbitfunComponents, {
  kind: 'openbitfun-host',
  source: '@openbitfun/ui component adapter',
}));
/**
 * Concrete adapter boundaries. OpenUI supplies the language runtime; these
 * objects own the component renderer, inspector, event and capability bridge
 * for one registered library family.
 */
export const openbitfunAdapter: GenUIImplementations = {
  components: openbitfunAdapterComponents,
  rendererSources: openbitfunRendererSources,
  functions,
};

/** The default profile uses the upstream Open Intelligent UI library directly. */
export const openUIAdapter: GenUIImplementations = {
  components: {},
  rendererSources: {},
  functions: {},
  nativeLibrary: openUILibrary,
};

export const genUIAdapterImplementations: Record<string, GenUIImplementations> = {
  openui: openUIAdapter,
  openbitfun: openbitfunAdapter,
};
