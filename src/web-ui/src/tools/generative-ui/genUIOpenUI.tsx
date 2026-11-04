import './disableOpenUIDevtools';
import { action, createLibrary, defineComponent, defineFunction, reactive, Renderer, useIsStreaming, useStateField, useTriggerAction, type ActionPlan } from '@openuidev/react-lang';
import { z } from 'zod/v4';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import type { GenUILibrary } from './genUILibrary';
import type { GenUIDesignSpec } from './genUIContract';
import type { GenUIAppState, GenUIOpenUIDocumentSource } from './genUITypes';
import type { GenUIRenderNode } from './genUITypes';
import type { GenUIAsyncRuntime, GenUIProviderInput, GenUITargetEvent } from './genUIAsyncCapabilities';
import { createGenUIAsyncRuntime, createOpenUIToolProvider } from './genUIAsyncCapabilities';
import { genUIActions, runGenUIAction } from './genUIActions';
import { OpenUIAsyncRuntimeContext } from './components/openui/runtime';

export interface GenUIOpenUIActionEvent {
  type: string;
  params: Record<string, unknown>;
  humanFriendlyMessage: string;
  formState?: Record<string, unknown>;
  formName?: string;
}
export interface GenUIOpenUIInspectEvent {
  component: string;
  statementId: string;
  passed: boolean;
  error?: string;
}
/** Native OpenUI function maps remain valid, while host-owned providers add
 * context, permissions, cancellation and target delivery around the same
 * Query/Mutation boundary. */
export type GenUIOpenUIToolProvider = GenUIProviderInput;

/**
 * OpenUI uses `$name` as the binding identity while GenUI persistence keeps
 * declaration keys as ordinary JSON fields (`name`). Keep that translation at
 * this adapter boundary so the renderer and the durable owner do not each
 * learn the other's state shape.
 */
function toOpenUIState(state?: GenUIAppState): GenUIAppState | undefined {
  if (!state) return state;
  const normalized = { ...state };
  for (const [key, value] of Object.entries(state)) {
    if (!key.startsWith('$') && !Object.prototype.hasOwnProperty.call(normalized, `$${key}`)) normalized[`$${key}`] = value;
  }
  return normalized;
}

function fromOpenUIState(state: GenUIAppState, ownerState?: GenUIAppState): GenUIAppState {
  const normalized = { ...state };
  for (const [key, value] of Object.entries(state)) {
    if (!key.startsWith('$')) continue;
    const ownerKey = key.slice(1);
    // Existing `$`-keyed documents remain byte-for-byte compatible. New
    // documents with ordinary declaration keys are projected back to the
    // owner's persisted shape.
    if (Object.prototype.hasOwnProperty.call(ownerState ?? {}, ownerKey) || !Object.prototype.hasOwnProperty.call(ownerState ?? {}, key)) {
      normalized[ownerKey] = value;
      delete normalized[key];
    }
  }
  return normalized;
}

type OpenUIComponent = ReturnType<typeof defineComponent>;

function GenUIComponentBoundary({
  component,
  statementId,
  view,
  implementation,
  children,
  onInspect,
}: {
  component: string;
  statementId: string;
  view: GenUIRenderNode;
  implementation: NonNullable<GenUILibrary['components'][string]>;
  children: ReactNode;
  onInspect?: (event: GenUIOpenUIInspectEvent) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!onInspect || !ref.current) return;
    let cancelled = false;
    const inspect = () => {
      if (cancelled || !ref.current) return;
      try {
        onInspect({ component, statementId, passed: implementation.inspect(ref.current, view) });
      } catch (error) {
        onInspect({ component, statementId, passed: false, error: error instanceof Error ? error.message : String(error) });
      }
    };
    // OpenUI hydrates reactive fields after its first commit. Inspect on the
    // next frame so the adapter checks the mounted value, not the transient
    // parser placeholder.
    const frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(inspect) : window.setTimeout(inspect, 0);
    return () => {
      cancelled = true;
      if (typeof frame === 'number' && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
      else window.clearTimeout(frame);
    };
  }, [component, implementation, onInspect, statementId, view]);
  return <div ref={ref} data-gen-ui-node={statementId} data-gen-ui-adapter-component={component} data-gen-ui-statement={statementId}>{children}</div>;
}

/**
 * The Open Intelligent UI renderer returns component output directly. The
 * product inspector is the only consumer that needs a DOM boundary, so keep
 * that instrumentation out of the normal FlowChat render tree. In particular
 * this avoids wrapper elements becoming flex/grid children and keeps SVG
 * primitives valid descendants of `<svg>`.
 */
function renderInspectableComponent(
  rendered: ReactNode,
  component: string,
  statementId: string,
  view: GenUIRenderNode,
  implementation: NonNullable<GenUILibrary['components'][string]>,
  onInspect?: (event: GenUIOpenUIInspectEvent) => void,
) {
  return onInspect
    ? <GenUIComponentBoundary component={component} statementId={statementId} view={view} implementation={implementation} onInspect={onInspect}>{rendered}</GenUIComponentBoundary>
    : rendered;
}

export function zodForSchema(schema: Record<string, unknown> | undefined): z.ZodTypeAny {
  if (!schema) return z.any();
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every(value => typeof value === 'string')) {
    return z.enum(schema.enum as [string, ...string[]]);
  }
  const union = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
  if (union) {
    const branches = union.map(branch => zodForSchema(branch as Record<string, unknown>));
    return branches.length > 1 ? z.union(branches as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]) : branches[0] ?? z.any();
  }
  switch (schema.type) {
    case 'string': return z.string();
    case 'number': return z.number();
    case 'integer': return z.number().int();
    // Models commonly serialize boolean component flags as 0/1. Accept those
    // exact JSON equivalents at the library boundary so one malformed flag
    // does not leave a visible render error above an otherwise valid page.
    case 'boolean': return z.union([
      z.boolean(),
      z.literal(0),
      z.literal(1),
    ]);
    case 'array': return z.array(zodForSchema(schema.items as Record<string, unknown> | undefined));
    case 'object': {
      const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      const required = new Set(Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === 'string') : []);
      const shape = Object.fromEntries(Object.entries(properties).map(([key, value]) => {
        const field = zodForSchema(value);
        return [key, required.has(key) ? field : field.optional()];
      }));
      const object = z.object(shape);
      return schema.additionalProperties === false ? object.strict() : object.catchall(z.any());
    }
    case 'null': return z.null();
    default: return z.any();
  }
}

/**
 * Adapt the selected product library to OpenUI's language runtime. The
 * catalog remains the source of truth for names, required fields and slot
 * relationships; renderer implementations stay in the trusted product
 * library. OpenUI owns parsing, streaming and state-field semantics.
 */
function createGenUIOpenUILibrary(library: GenUILibrary, options: { onInspect?: (event: GenUIOpenUIInspectEvent) => void; asyncRuntime?: GenUIAsyncRuntime; readOnly?: boolean; executeActions?: boolean; htmlScriptEnabled?: boolean } = {}) {
  const components: OpenUIComponent[] = Object.entries(library.contract.components).map(([name, contract]) => {
    const props: Record<string, z.ZodTypeAny> = {};
    // OpenUI uses declaration order for positional arguments. Put child slots
    // first so the natural `Col([Text(...)])` form remains composable; the
    // generated prompt exposes the resulting signature to the model.
    for (const slot of Object.keys(contract.slots)) {
      const slotSchema = z.array(z.any());
      props[slot] = contract.slotRequired?.[slot] ? slotSchema : slotSchema.optional();
    }
    const declaredProps = Object.keys(contract.props.properties ?? {});
    const required = new Set((contract.props.required as string[] | undefined) ?? []);
    const declaredSchemas = (contract.props.properties ?? {}) as Record<string, Record<string, unknown>>;
    // Keep required visual props before the optional action slot so a normal
    // Button("Save", @ToAssistant("...")) remains positional and readable.
    for (const key of declaredProps.filter(key => required.has(key))) {
      if (!Object.prototype.hasOwnProperty.call(props, key)) props[key] = zodForSchema(declaredSchemas[key]);
    }
    // OpenUI action is a language-level prop. It is deliberately added only
    // to product components that declare an interaction event, keeping the
    // catalog's trusted visual props unchanged while allowing the selected
    // owner to receive a structured action plan. Its position is part of the
    // generated positional signature and is never reinterpreted at runtime.
    if (contract.action) props.action = action().optional();
    for (const key of declaredProps.filter(key => !required.has(key))) {
      if (!Object.prototype.hasOwnProperty.call(props, key)) props[key] = zodForSchema(declaredSchemas[key]).optional();
    }
    const bindingProps = new Set(contract.bindings ?? []);
    // Preserve OpenUI `$variable` bindings for writable form values. The
    // product catalog remains the source of truth for the prop shape; the
    // binding list opts fields such as value, checked, selected and seconds
    // into OpenUI's StateField semantics.
    const schema = z.object(Object.fromEntries(Object.entries(props).map(([key, value]) => [key, bindingProps.has(key) ? reactive(value) : value])));
    const implementation = library.components[name];
    const component = defineComponent({
      name,
      description: contract.description,
      props: schema,
      component: ({ props: values, renderNode, statementId }) => {
        // react-lang invokes this callback as a component, but its public
        // defineComponent type intentionally keeps the callback lowercase.
        // These hooks therefore follow the renderer's stable callback order.
        // eslint-disable-next-line react-hooks/rules-of-hooks
        const triggerAction = useTriggerAction();
        // Keep product adapters on the same streaming boundary as OpenUI.
        // Map uses this to wait for a complete marker list before routing.
        // eslint-disable-next-line react-hooks/rules-of-hooks
        const isStreaming = useIsStreaming();
        const rawValues = values as Record<string, unknown>;
        const normalizedValues = { ...rawValues };
        for (const [key, schema] of Object.entries(declaredSchemas)) {
          if (schema.type === 'boolean' && (rawValues[key] === 0 || rawValues[key] === 1)) {
            normalizedValues[key] = rawValues[key] === 1;
          }
        }
        if (contract.action && Object.prototype.hasOwnProperty.call(rawValues, 'action')) {
          // OpenUI's action slot is positional and has one canonical place:
          // after required visual props and before optional visual props. Do
          // not reinterpret trailing values here; doing so makes the same
          // source program behave differently from Open Intelligent UI.
        }
        const stateFields = new Map<string, ReturnType<typeof useStateField>>();
        const resolvedValues = { ...normalizedValues };
        for (const key of bindingProps) {
          const raw = normalizedValues[key];
          // `bindingProps` is fixed by the catalog for this component; the
          // renderer invokes one state hook per declared binding in order.
          // eslint-disable-next-line react-hooks/rules-of-hooks
          const field = useStateField(key, raw);
          stateFields.set(key, field);
          if (field.isReactive) resolvedValues[key] = field.value;
        }
        const view = {
          key: statementId ?? name,
          node: { id: statementId ?? name, component: name, props: resolvedValues, slots: {}, events: {} },
          props: resolvedValues,
          item: undefined,
          slots: {},
        } as unknown as GenUIRenderNode;
        const slots = Object.fromEntries(Object.keys(contract.slots).map(slot => [
          slot,
          (Array.isArray(resolvedValues[slot])
            ? (resolvedValues[slot] as unknown[]).map((child, index) => <Fragment key={`${statementId ?? name}-${slot}-${index}`}>{renderNode(child)}</Fragment>)
            : []) as ReactNode[],
        ]));
        const rendered = implementation.render({
          view,
          slots,
          renderNode,
          // `readOnly` is a host policy, while `isStreaming` belongs to the
          // OpenUI renderer. Keep them separate: OpenUI still mounts the
          // completed tree while a source is streaming, and its trusted
          // components decide which controls are temporarily unavailable.
          disabled: options.readOnly === true,
          asyncRuntime: options.asyncRuntime,
          isStreaming,
          htmlScriptEnabled: options.htmlScriptEnabled === true,
          emit: (event, value) => {
            if ((event === 'change' || event === 'input') && value !== undefined) {
              for (const binding of bindingProps) {
                const field = stateFields.get(binding);
                if (field?.isReactive) field.setValue(value);
              }
            }
            const plan = normalizedValues.action;
            // Open Intelligent UI treats a plain Button as a conversational
            // affordance. The runtime's undefined plan is intentional: it
            // becomes the built-in continue_conversation action with the
            // button label as its human-facing message.
            if (!plan && name !== 'Button') return;
            const message = name === 'Button' ? String(normalizedValues.label ?? name) : `${name}.${event}${value === undefined ? '' : `:${String(value)}`}`;
            void triggerAction(message, undefined, plan as ActionPlan | undefined);
          },
        });
        return renderInspectableComponent(rendered, name, statementId ?? name, view, implementation, options.onInspect);
      },
    });
    return component;
  });
  // OpenUI Lang already owns the core data calls (Count through Each). They
  // are still part of the product contract and prompt, but registering them
  // again would collide with the runtime's built-ins. Only the extension
  // functions are added to the selected library.
  const openUIBuiltins = new Set(['Count', 'First', 'Last', 'Sum', 'Avg', 'Min', 'Max', 'Sort', 'Filter', 'Round', 'Abs', 'Floor', 'Ceil', 'Each']);
  const functions = Object.entries(library.contract.functions).filter(([name]) => !openUIBuiltins.has(name)).map(([name, contract]) => {
    const optionalParams = new Set(contract.optionalParams ?? []);
    const params = Object.fromEntries(contract.params.map((schema, index) => {
      const field = zodForSchema(schema);
      return [`arg${index}`, optionalParams.has(index) ? field.optional() : field];
    }));
    const implementation = library.functions[name];
    return defineFunction({
      name,
      description: contract.description,
      params: z.object(params),
      returns: zodForSchema(contract.returns),
      fn: args => implementation(...Object.values(args)),
    });
  });
  const root = library.contract.metadata?.rootComponent ?? components[0]?.name;
  if (!root) throw new Error(`${library.contract.id}: OpenUI library has no components`);
  return createLibrary({ components, functions, actions: genUIActions, root });
}

export default function GenUIOpenUIDocument({
  source,
  library,
  initialState,
  isStreaming = false,
  readOnly = false,
  executeActions = true,
  onStateUpdate,
  onError,
  onAction,
  onInspect,
  toolProvider,
  asyncProvider,
  asyncRuntime: suppliedAsyncRuntime,
  htmlScriptEnabled = false,
  asyncPermissions,
  asyncTarget = 'local',
  asyncTargetId,
  onTargetEvent,
  onParseResult,
  appId,
  sourceKey,
}: {
  source: GenUIOpenUIDocumentSource;
  library: GenUILibrary;
  specification?: GenUIDesignSpec;
  initialState?: GenUIAppState;
  isStreaming?: boolean;
  readOnly?: boolean;
  /** Keep product side effects out of disposable verification probes. */
  executeActions?: boolean;
  onStateUpdate?: (state: GenUIAppState) => void;
  onError?: (message: string) => void;
  onAction?: (event: GenUIOpenUIActionEvent) => void | Promise<void>;
  onInspect?: (event: GenUIOpenUIInspectEvent) => void;
  /** Explicit owner-registered Query/Mutation capabilities; absent by default. */
  toolProvider?: GenUIOpenUIToolProvider;
  /** Preferred explicit provider name for image/map and Query/Mutation calls. */
  asyncProvider?: GenUIProviderInput;
  asyncRuntime?: GenUIAsyncRuntime;
  /** Explicit product opt-in for local HtmlView scripts after streaming. */
  htmlScriptEnabled?: boolean;
  asyncPermissions?: readonly string[];
  asyncTarget?: 'local' | 'workspace' | 'peer' | 'unsupported';
  asyncTargetId?: string;
  onTargetEvent?: (event: GenUITargetEvent) => void | Promise<void>;
  onParseResult?: (result: unknown) => void;
  appId?: string;
  sourceKey?: string;
}) {
  // Keep the OpenUI library identity stable while reactive state updates. A
  // fresh library object makes react-lang rebuild its renderer tree after the
  // first keystroke, which drops focus and turns normal text entry into a
  // one-character interaction. The callback is read through a ref so
  // verification hosts may still replace it without remounting the document.
  const onInspectRef = useRef(onInspect);
  onInspectRef.current = onInspect;
  const streamingSourceIdentity = `${appId ?? 'genui'}:${source.kind}`;
  const initialSourceKey = useRef(sourceKey ?? streamingSourceIdentity).current;
  const ownedAsyncRuntime = useMemo(() => {
    if (suppliedAsyncRuntime) return undefined;
    return createGenUIAsyncRuntime({
      provider: asyncProvider ?? toolProvider,
      appId: appId ?? 'genui',
      sourceKey: initialSourceKey,
      policy: { permissions: asyncPermissions, target: asyncTarget, targetId: asyncTargetId },
      onTargetEvent,
    });
  }, [suppliedAsyncRuntime, asyncProvider, toolProvider, asyncPermissions, asyncTarget, asyncTargetId, onTargetEvent, appId, initialSourceKey]);
  const runtime = suppliedAsyncRuntime ?? ownedAsyncRuntime;
  const runtimeSourceInitialized = useRef(false);
  useLayoutEffect(() => {
    // OpenUI updates the source text for every token but keeps the component
    // identity alive. Do the same for the owned provider runtime so a query
    // that settled during streaming is not cancelled by an unrelated later
    // statement; a non-streaming replacement still receives its full key.
    const nextSourceKey = isStreaming ? initialSourceKey : (sourceKey ?? source.content);
    ownedAsyncRuntime?.updateSourceKey?.(nextSourceKey, runtimeSourceInitialized.current);
    runtimeSourceInitialized.current = true;
  }, [ownedAsyncRuntime, initialSourceKey, isStreaming, sourceKey, source.content]);
  useEffect(() => {
    ownedAsyncRuntime?.setTargetEventHandler(onTargetEvent);
  }, [ownedAsyncRuntime, onTargetEvent]);
  useEffect(() => () => ownedAsyncRuntime?.abortAll('OpenUI document was unmounted'), [ownedAsyncRuntime]);
  const inspectAdapter = useCallback((event: GenUIOpenUIInspectEvent) => {
    onInspectRef.current?.(event);
  }, []);
  const inspectCallback = onInspect ? inspectAdapter : undefined;
  const openUILibrary = useMemo(
    () => library.nativeLibrary ?? createGenUIOpenUILibrary(library, { ...(inspectCallback ? { onInspect: inspectCallback } : {}), asyncRuntime: runtime, readOnly, executeActions, htmlScriptEnabled }),
    [library, inspectCallback, runtime, readOnly, executeActions, htmlScriptEnabled],
  );
  // The OpenUI runtime uses the initial-state identity as an effect input.
  // Rebuilding the translated object on every parent render makes its store
  // re-hydrate while the owner is committing the same snapshot, which can
  // produce a render/update loop in a live FlowChat answer.
  const openUIInitialState = useMemo(() => toOpenUIState(initialState), [initialState]);
  const ownerStateRef = useRef(initialState);
  ownerStateRef.current = initialState;
  const handleStateUpdate = useCallback((state: GenUIAppState) => {
    onStateUpdate?.(fromOpenUIState(state, ownerStateRef.current));
  }, [onStateUpdate]);
  const handleAction = useCallback((event: GenUIOpenUIActionEvent) => {
    // Custom actions have a safe product default. The callback still receives
    // the event so an owning host can observe it or add its own delivery.
    if (executeActions) void runGenUIAction(event);
    void onAction?.(event);
  }, [executeActions, onAction]);
  const handleError = useCallback((errors: Array<{ message: string }>) => {
    if (errors.length) onError?.(errors.map(error => error.message).join('; '));
  }, [onError]);
  return <OpenUIAsyncRuntimeContext.Provider value={runtime}>
    <Renderer
      response={source.content}
      library={openUILibrary}
      isStreaming={isStreaming}
      initialState={openUIInitialState}
      onAction={handleAction as never}
      toolProvider={runtime && (asyncProvider ?? toolProvider) ? createOpenUIToolProvider(asyncProvider ?? toolProvider!, runtime) : undefined}
      onStateUpdate={handleStateUpdate}
      onParseResult={result => onParseResult?.(result)}
      onError={handleError}
    />
  </OpenUIAsyncRuntimeContext.Provider>;
}

