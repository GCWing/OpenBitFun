/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GenUIOpenUIDocument from './genUIOpenUI';
import { zodForSchema } from './genUIOpenUISchema';
import GenUIApplication from './GenUIApplication';
import { genUIProduct } from './genUIProduct';
import { genUICatalog } from './genUIContract';
import { oiComponents } from './components/oiComponents';
import type { GenUIAppDefinition } from './genUITypes';
import type { GenUIAsyncContext, GenUITargetEvent } from './genUIAsyncCapabilities';

describe('OpenUI source adapter', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('accepts JSON numeric equivalents for boolean component props', () => {
    const booleanProp = zodForSchema({ type: 'boolean' });
    expect(booleanProp.parse(0)).toBe(0);
    expect(booleanProp.parse(1)).toBe(1);
    expect(booleanProp.parse(false)).toBe(false);
    expect(() => booleanProp.parse(2)).toThrow();
  });

  it('forwards a generated action plan to the owning host', async () => {
    const onAction = vi.fn();
    await act(async () => root.render(<GenUIOpenUIDocument
      source={{ kind: 'openui-lang', content: 'root = Col([label, button])\nlabel = Title("OpenUI")\nbutton = Button("Ping", @ToAssistant("Ping from OpenUI"))' }}
      library={genUIProduct.libraries['openbitfun.composable.v1']}
      onAction={onAction}
    />));

    expect(container.textContent).toContain('OpenUI');
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button')?.click();
      await Promise.resolve();
    });
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ type: 'continue_conversation' }));
  });

  it('runs Open Intelligent UI CopyToClipboard actions and still reports them to the host', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const onAction = vi.fn();
    await act(async () => root.render(<GenUIOpenUIDocument
      source={{ kind: 'openui-lang', content: 'root = Button("Copy", @CopyToClipboard("hello"))' }}
      library={genUIProduct.libraries['openbitfun.composable.v1']}
      onAction={onAction}
    />));

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button')?.click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({
      type: 'CopyToClipboard',
      params: { text: 'hello' },
    }));
  });

  it('falls back to execCommand when the Clipboard API is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('blocked')) } });
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
    await act(async () => root.render(<GenUIOpenUIDocument
      source={{ kind: 'openui-lang', content: 'root = Button("Copy", @CopyToClipboard("fallback"))' }}
      library={genUIProduct.libraries['openbitfun.composable.v1']}
    />));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button')?.click();
      await Promise.resolve();
    });
    expect(execCommand).toHaveBeenCalledWith('copy');
  });



  it('runs only explicitly registered Query capabilities', async () => {
    const provider = vi.fn(async () => ({ value: 'from owner' }));
    await act(async () => root.render(<GenUIOpenUIDocument
      source={{ kind: 'openui-lang', content: 'root = Col([label])\nresult = Query("read_value", {}, {value: "fallback"})\nlabel = Text(result.value)' }}
      library={genUIProduct.libraries['openbitfun.composable.v1']}
      toolProvider={{ read_value: provider }}
    />));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(provider).toHaveBeenCalledWith({}, expect.objectContaining({
      capability: 'read_value',
      operation: 'query',
      signal: expect.any(AbortSignal),
    }));
    expect(container.textContent).toContain('from owner');
  });

  it('routes OpenUI Query through the owner async capability context', async () => {
    let context: GenUIAsyncContext | undefined;
    const asyncProvider = {
      capabilities: { read_value: { kind: 'query' as const, permission: 'data.read', target: 'local' as const } },
      call: vi.fn(async (_name: string, _args: Record<string, unknown>, next: GenUIAsyncContext) => {
        context = next;
        return { value: 'from async owner' };
      }),
    };
    await act(async () => root.render(<GenUIOpenUIDocument
      source={{ kind: 'openui-lang', content: 'root = Text(result.value)\nresult = Query("read_value", {}, {value: "fallback"})' }}
      library={genUIProduct.libraries['openbitfun.composable.v1']}
      asyncProvider={asyncProvider}
      asyncPermissions={['data.read']}
      appId="async-app"
      sourceKey="async-source"
    />));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(asyncProvider.call).toHaveBeenCalledTimes(1);
    expect(context).toMatchObject({ appId: 'async-app', sourceKey: 'async-source', capability: 'read_value', operation: 'query' });
    expect(context?.signal.aborted).toBe(false);
    expect(container.textContent).toContain('from async owner');
  });

  it('routes OpenUI Mutation through the owner async capability context', async () => {
    let context: GenUIAsyncContext | undefined;
    const asyncProvider = {
      capabilities: { save_value: { kind: 'mutation' as const, permission: 'data.write', target: 'local' as const } },
      call: vi.fn(async (_name: string, args: Record<string, unknown>, next: GenUIAsyncContext) => {
        context = next;
        return { saved: args.value };
      }),
    };
    await act(async () => root.render(<GenUIOpenUIDocument
      source={{ kind: 'openui-lang', content: 'root = Col([button, result])\n$value = "draft"\nresult = Mutation("save_value", {value: $value})\nbutton = Button("Save", @Run(result))' }}
      library={genUIProduct.libraries['openbitfun.composable.v1']}
      asyncProvider={asyncProvider}
      asyncPermissions={['data.write']}
      onError={vi.fn()}
    />));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(asyncProvider.call).toHaveBeenCalledWith('save_value', { value: 'draft' }, context);
    expect(context).toMatchObject({ capability: 'save_value', operation: 'mutation', permission: 'data.write' });
  });

  it('fills SearchImage and Map through registered providers and emits target events', async () => {
    const events: GenUITargetEvent[] = [];
    const asyncProvider = {
      capabilities: {
        'image.search': { kind: 'image-search' as const, target: 'local' as const },
        'map.lookup': { kind: 'map-query' as const, target: 'local' as const },
        'event.map.marker.select': { kind: 'event' as const, target: 'local' as const },
      },
      call: vi.fn(async (name: string) => name === 'image.search' ? ['https://example.com/photo.jpg'] : [[{ label: 'Home', lat: '31.2', lon: '121.5' }]]),
    };
    await act(async () => root.render(<GenUIOpenUIDocument
      source={{ kind: 'openui-lang', content: 'root = Col([photo, map])\nphoto = SearchImage("a city")\nmap = Map([], false, null, null, "Shanghai")' }}
      library={genUIProduct.libraries['openbitfun.composable.v1']}
      asyncProvider={asyncProvider}
      onTargetEvent={event => events.push(event)}
    />));
    await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 650)); await Promise.resolve(); });
    expect(container.querySelector<HTMLImageElement>('.gen-ui-oi-image img')?.src).toBe('https://example.com/photo.jpg');
    expect(container.querySelector<SVGGElement>('[role="button"][aria-label="Home"]')).not.toBeNull();
    await act(async () => { container.querySelector<SVGGElement>('[role="button"][aria-label="Home"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'map.marker.select', payload: expect.objectContaining({ label: 'Home' }) })]));
  });

  it('falls back from a failed explicit image URL to the host image provider', async () => {
    const asyncProvider = {
      capabilities: { 'image.search': { kind: 'image-search' as const, target: 'local' as const } },
      call: vi.fn(async () => ['https://example.com/fallback.jpg']),
    };
    await act(async () => root.render(<GenUIOpenUIDocument
      source={{ kind: 'openui-lang', content: 'root = Image("https://example.com/broken.jpg", "A city")' }}
      library={genUIProduct.libraries['openbitfun.composable.v1']}
      asyncProvider={asyncProvider}
    />));
    await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 20)); });
    const image = container.querySelector<HTMLImageElement>('.gen-ui-oi-image img');
    expect(image?.src).toBe('https://example.com/broken.jpg');
    act(() => { image?.dispatchEvent(new Event('error')); });
    await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 650)); });
    expect(asyncProvider.call).toHaveBeenCalledWith('image.search', { query: 'A city' }, expect.anything());
    expect(container.querySelector<HTMLImageElement>('.gen-ui-oi-image img')?.src).toBe('https://example.com/fallback.jpg');
  });

  it('lets a debounced image query resolve while the source is streaming', async () => {
    const asyncProvider = {
      capabilities: { 'image.search': { kind: 'image-search' as const, target: 'local' as const } },
      call: vi.fn(async () => ({ images: ['https://example.com/streaming.jpg'] })),
    };
    await act(async () => root.render(<GenUIOpenUIDocument
      source={{ kind: 'openui-lang', content: 'root = SearchImage("A city")' }}
      library={genUIProduct.libraries['openbitfun.composable.v1']}
      isStreaming
      asyncProvider={asyncProvider}
    />));
    await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 650)); });
    expect(asyncProvider.call).toHaveBeenCalledWith('image.search', { query: 'A city' }, expect.anything());
    expect(container.querySelector<HTMLImageElement>('.gen-ui-oi-image img')?.src).toBe('https://example.com/streaming.jpg');
  });

  it('uses a registered map route provider while retaining the direct overview fallback', async () => {
    const asyncProvider = {
      capabilities: { 'map.route': { kind: 'map-query' as const, target: 'local' as const } },
      call: vi.fn(async () => ({ points: [[31.2, 121.5], [31.25, 121.55], [31.3, 121.6]] })),
    };
    await act(async () => root.render(<GenUIOpenUIDocument
      source={{ kind: 'openui-lang', content: 'root = Map([{label: "Home", lat: 31.2, lng: 121.5}, {label: "Work", lat: 31.3, lng: 121.6}], true)' }}
      library={genUIProduct.libraries['openbitfun.composable.v1']}
      isStreaming
      asyncProvider={asyncProvider}
    />));
    await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 800)); });
    expect(asyncProvider.call).toHaveBeenCalledWith('map.route', { markers: expect.arrayContaining([expect.objectContaining({ label: 'Home' }), expect.objectContaining({ label: 'Work' })]) }, expect.anything());
    expect(container.querySelector<SVGPolylineElement>('.gen-ui-oi-map-route')?.getAttribute('points')).toContain(',');
  });

  it('accepts a GeoJSON route feature from an OSRM adapter', async () => {
    const asyncProvider = {
      capabilities: { 'map.route': { kind: 'map-query' as const, target: 'local' as const } },
      call: vi.fn(async () => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[121.5, 31.2], [121.55, 31.25], [121.6, 31.3]] },
      })),
    };
    await act(async () => root.render(<GenUIOpenUIDocument
      source={{ kind: 'openui-lang', content: 'root = Map([{label: "Home", lat: 31.2, lng: 121.5}, {label: "Work", lat: 31.3, lng: 121.6}], true)' }}
      library={genUIProduct.libraries['openbitfun.composable.v1']}
      isStreaming
      asyncProvider={asyncProvider}
    />));
    await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 800)); });
    expect(asyncProvider.call).toHaveBeenCalledWith('map.route', expect.anything(), expect.anything());
    expect(container.querySelector<SVGPolylineElement>('.gen-ui-oi-map-route')?.getAttribute('points')).toContain(',');
  });

  it('uses the selected product library for OpenUI functions', async () => {
    await act(async () => root.render(<GenUIOpenUIDocument
      source={{ kind: 'openui-lang', content: 'root = Col([total, sine])\ntotal = Text(@Sum([2, 3]))\nsine = Text(@Round(@Sin(1.5707963267948966), 2))' }}
      library={genUIProduct.libraries['openbitfun.composable.v1']}
    />));
    expect(container.textContent).toContain('5');
    expect(container.textContent).toContain('1');
  });

  it('binds reactive OpenUI values to owner state updates', async () => {
    const onStateUpdate = vi.fn();
    const onAction = vi.fn();
    await act(async () => root.render(<GenUIOpenUIDocument
      source={{ kind: 'openui-lang', content: 'root = Col([input, text])\ninput = Input($name, "Name", "text", @ToAssistant("Name changed"))\ntext = Text($name)' }}
      library={genUIProduct.libraries['openbitfun.composable.v1']}
      initialState={{ $name: 'Initial' }}
      onStateUpdate={onStateUpdate}
      onAction={onAction}
    />));

    const input = container.querySelector<HTMLInputElement>('input[aria-label="Name"]');
    expect(input?.value).toBe('Initial');
    expect(container.textContent).toContain('Initial');

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Updated');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onStateUpdate).toHaveBeenCalledWith(expect.objectContaining({ $name: 'Updated' }));
    expect(input?.value).toBe('Updated');
    expect(container.textContent).toContain('Updated');
  });

  it('keeps completed controls interactive while the source is streaming', async () => {
    const onStateUpdate = vi.fn();
    await act(async () => root.render(<GenUIOpenUIDocument
      source={{ kind: 'openui-lang', content: 'root = Col([input, text])\ninput = Input($name, "Name", "text")\ntext = Text($name)' }}
      library={genUIProduct.libraries['openbitfun.composable.v1']}
      initialState={{ name: 'Initial' }}
      isStreaming
      onStateUpdate={onStateUpdate}
    />));

    const input = container.querySelector<HTMLInputElement>('input[aria-label="Name"]');
    expect(input?.disabled).not.toBe(true);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Updated');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    expect(onStateUpdate).toHaveBeenCalledWith(expect.objectContaining({ name: 'Updated' }));
  });

  it('matches OpenUI action control semantics while streaming', async () => {
    await act(async () => root.render(<GenUIOpenUIDocument
      source={{ kind: 'openui-lang', content: 'root = Col([button, input])\nbutton = Button("Continue")\ninput = Input($name, "Name", "text")' }}
      library={genUIProduct.libraries['openbitfun.composable.v1']}
      initialState={{ name: 'Initial' }}
      isStreaming
    />));

    expect(container.querySelector<HTMLButtonElement>('[data-openbitfun-component="button"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Name"]')?.disabled).toBe(false);
  });

  it('keeps read-only completed documents out of streaming mode', async () => {
    await act(async () => root.render(<GenUIOpenUIDocument
      source={{ kind: 'openui-lang', content: 'root = Col([button, html])\nbutton = Button("Continue")\nhtml = HtmlView("<p>Ready</p>")' }}
      library={genUIProduct.libraries['openbitfun.composable.v1']}
      readOnly
    />));

    expect(container.querySelector<HTMLButtonElement>('[data-openbitfun-component="button"]')?.disabled).toBe(true);
    expect(container.querySelector('.gen-ui-oi-html')).not.toBeNull();
  });

  it('keeps completed statements mounted when a later statement is incomplete', async () => {
    const onError = vi.fn();
    await act(async () => root.render(<GenUIOpenUIDocument
      source={{ kind: 'openui-lang', content: 'root = Col([text])\ntext = Text("Already visible")\nbroken = Text(' }}
      library={genUIProduct.libraries['openbitfun.composable.v1']}
      isStreaming
      onError={onError}
    />));
    expect(container.textContent).toContain('Already visible');
    expect(container.querySelector('.gen-ui-oi-col')).not.toBeNull();
  });

  it('defers HtmlView execution until the OpenUI source stream completes', async () => {
    await act(async () => root.render(<GenUIOpenUIDocument
      source={{ kind: 'openui-lang', content: 'root = HtmlView("<script>window.bad = true</script><p>Ready</p>")' }}
      library={genUIProduct.libraries['openbitfun.composable.v1']}
      isStreaming
    />));
    expect(container.querySelector('.gen-ui-oi-html')).toBeNull();
    expect(container.querySelector('.gen-ui-oi-html-slot')).not.toBeNull();
  });

  it('runs an opted-in HtmlView inline script after the source completes', async () => {
    await act(async () => root.render(<GenUIOpenUIDocument
      source={{ kind: 'openui-lang', content: 'root = HtmlView("<canvas id=\\"pendulum\\"></canvas><script>requestAnimationFrame(() => {})</script>", 360, "Pendulum")' }}
      library={genUIProduct.libraries['openbitfun.composable.v1']}
      htmlScriptEnabled
    />));
    const frame = container.querySelector<HTMLIFrameElement>('.gen-ui-oi-html');
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute('srcdoc') ?? frame?.srcdoc).toContain('requestAnimationFrame');
    expect(frame?.getAttribute('srcdoc') ?? frame?.srcdoc).toMatch(/script-src 'nonce-[0-9a-f]+'/);
  });

  it('keeps the application interactive during streaming without persisting transient state', async () => {
    const onStateChange = vi.fn();
    const definition: GenUIAppDefinition = {
      schemaVersion: 2,
      id: 'streaming-app',
      title: 'Streaming app',
      template: 'openbitfun.app',
      libraryId: 'openbitfun.composable.v1',
      libraryRevision: 2,
      designSpec: { id: 'openbitfun.desktop.v1', revision: 1 },
      source: {
        kind: 'openui-lang',
        content: 'root = Col([input])\ninput = Input($name, "Name", "text")',
      },
      state: { name: { type: 'string', default: 'Initial' } },
    };

    await act(async () => root.render(<GenUIApplication
      definition={definition}
      streaming
      initialState={{ name: 'Initial' }}
      persistState={false}
      onStateChange={onStateChange}
    />));

    const input = container.querySelector<HTMLInputElement>('input[aria-label="Name"]');
    expect(input?.disabled).toBe(false);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Updated');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    expect(onStateChange).not.toHaveBeenCalled();
  });

  it('renders SegmentedControl with owner state defaults', async () => {
    await act(async () => root.render(<GenUIOpenUIDocument
      source={{ kind: 'openui-lang', content: 'root = SegmentedControl($stage, [{"value":"探索","label":"探索"},{"value":"建设","label":"建设"}])' }}
      library={genUIProduct.libraries['openbitfun.composable.v1']}
      initialState={{ stage: '探索' }}
    />));
    expect(container.textContent).toContain('探索');
  });

  it('renders the Open Intelligent UI layout and title primitives', async () => {
    await act(async () => root.render(<GenUIOpenUIDocument
      source={{ kind: 'openui-lang', content: 'root = Col([heading, body])\nheading = Title("Overview")\nbody = Row([Text("A"), Box([Text("B")])])' }}
      library={genUIProduct.libraries['openbitfun.composable.v1']}
    />));
    expect(container.querySelector('.gen-ui-oi-col')).not.toBeNull();
    expect(container.querySelector('.gen-ui-oi-row')).not.toBeNull();
    expect(container.querySelector('.gen-ui-oi-box')).not.toBeNull();
    expect(container.querySelector('.gen-ui-oi-title')?.textContent).toBe('Overview');
  });

  it('uses the vendored upstream library and CSS for the Open Intelligent UI profile', async () => {
    await act(async () => root.render(<GenUIOpenUIDocument
      source={{ kind: 'openui-lang', content: 'root = Col([heading, body])\nheading = Title("Open Intelligent UI")\nbody = Text("Upstream styles")' }}
      library={genUIProduct.libraries['openui.v1']}
    />));
    expect(genUIProduct.libraries['openui.v1'].nativeLibrary).toBeDefined();
    expect(container.querySelector('.iui-col')).not.toBeNull();
    expect(container.querySelector('.iui-title')?.textContent).toBe('Open Intelligent UI');
    expect(container.querySelector('.gen-ui-oi-col')).toBeNull();
  });

  it('routes vendored Open Intelligent UI SearchImage through the host provider', async () => {
    const asyncProvider = {
      capabilities: { 'image.search': { kind: 'image-search' as const, target: 'local' as const } },
      call: vi.fn(async () => ({ images: ['https://example.com/shanghai.jpg'] })),
    };
    await act(async () => root.render(<GenUIOpenUIDocument
      source={{ kind: 'openui-lang', content: 'root = SearchImage("Shanghai Bund")' }}
      library={genUIProduct.libraries['openui.v1']}
      asyncProvider={asyncProvider}
    />));
    await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 650)); });
    expect(asyncProvider.call).toHaveBeenCalledWith('image.search', { query: 'Shanghai Bund' }, expect.anything());
    expect(container.querySelector<HTMLImageElement>('.iui-image img')?.src).toBe('https://example.com/shanghai.jpg');
  });

  it('mounts OpenBitFun controls through @openbitfun/ui while keeping GenUI visuals local', async () => {
    await act(async () => root.render(<GenUIOpenUIDocument
      source={{ kind: 'openui-lang', content: 'root = Col([card, chart])\ncard = Card([Button("Continue"), Input($name, "Name", "text")], "soft")\nchart = Chart("line", [{label: "A", value: 1}, {label: "B", value: 2}], "label", ["value"])' }}
      library={genUIProduct.libraries['openbitfun.composable.v1']}
      initialState={{ name: 'OpenBitFun' }}
    />));
    expect(container.querySelector('[data-openbitfun-component="card"]')).not.toBeNull();
    expect(container.querySelector('[data-openbitfun-component="button"]')).not.toBeNull();
    expect(container.querySelector('[data-openbitfun-component="input"]')).not.toBeNull();
    expect(container.querySelector('[data-chart-type="line"]')).not.toBeNull();
  });

  it('keeps the transient OpenUI tree free of inspector boundaries', async () => {
    await act(async () => root.render(<GenUIOpenUIDocument
      source={{ kind: 'openui-lang', content: 'root = Col([drawing])\ndrawing = Svg([circle], "0 0 20 20")\ncircle = Circle(10, 10, 5, "accent")' }}
      library={genUIProduct.libraries['openbitfun.composable.v1']}
    />));
    expect(container.querySelector('[data-gen-ui-node]')).toBeNull();
    expect(container.querySelector('svg > circle')).not.toBeNull();
  });

  it('renders OpenUI chart variants through their native visual branches', async () => {
    for (const type of ['line', 'pie', 'scatter'] as const) {
      await act(async () => root.render(<GenUIOpenUIDocument
        source={{ kind: 'openui-lang', content: `root = Chart("${type}", [{label: "A", x: 1, value: 2}, {label: "B", x: 2, value: 3}], "${type === 'scatter' ? 'x' : 'label'}", ["value"])` }}
        library={genUIProduct.libraries['openbitfun.composable.v1']}
      />));
      expect(container.querySelector(`[data-chart-type="${type}"]`)).not.toBeNull();
    }
  });

  it('allows the transient unhydrated SegmentedControl value to settle on its first option', () => {
    const render = oiComponents.SegmentedControl.render;
    expect(() => render({
      view: {
        props: {
          label: 'Stage',
          value: undefined,
          options: [{ value: '探索', label: '探索' }, { value: '建设', label: '建设' }],
        },
      } as never,
      slots: {},
      disabled: false,
      emit: vi.fn(),
    })).not.toThrow();
  });

  it('still rejects duplicate SegmentedControl options', () => {
    const render = oiComponents.SegmentedControl.render;
    expect(() => render({
      view: {
        props: {
          label: 'Stage',
          value: '探索',
          options: [{ value: '探索', label: '探索' }, { value: '探索', label: 'Duplicate' }],
        },
      } as never,
      slots: {},
      disabled: false,
      emit: vi.fn(),
    })).toThrow('SegmentedControl requires unique options');
  });
});
