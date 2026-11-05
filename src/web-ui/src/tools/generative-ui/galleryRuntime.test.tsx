// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gallerySections, lifePlanProgram, toolGalleryPrograms } from '../../../../shared/generative-ui/gallery';
import { galleryProgramToApp, galleryToolProvider } from './galleryRuntime';
import GenUIOpenUIDocument from './genUIOpenUI';
import { genUIProduct } from './genUIProduct';
import { preflightGenUIApp } from './genUIContract';

describe('OpenUI Lang gallery fixtures', () => {
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

  it('registers the original gallery groups and the OpenBitFun life-plan fixture', () => {
    expect(gallerySections.find(section => section.id === 'composition')?.programs).toHaveLength(4);
    expect(toolGalleryPrograms.filter(program => program.example !== 'life-plan')).toHaveLength(18);
    expect(gallerySections.find(section => section.id === 'components')?.programs.length).toBeGreaterThan(10);
    expect(gallerySections.find(section => section.id === 'prompt-examples')?.programs).toHaveLength(4);
    expect(lifePlanProgram.code).toContain('Chart("area"');
    expect(lifePlanProgram.code).toContain('Table(');
    expect(lifePlanProgram.code).toContain('@Toggle');
  });

  it('turns every fixture into a valid OpenBitFun app envelope', () => {
    for (const program of gallerySections.flatMap(section => section.programs)) {
      const app = galleryProgramToApp(program);
      expect(preflightGenUIApp(app).accepted, program.id).toBe(true);
    }
  });

  it('renders the life-plan fixture through the trusted OpenUI renderer', async () => {
    const app = galleryProgramToApp(lifePlanProgram);
    await act(async () => root.render(<GenUIOpenUIDocument source={app.source} library={genUIProduct.libraries[app.libraryId]} initialState={{}} />));
    expect(container.textContent).toContain('Life plan');
    expect(container.textContent).toContain('Progress view');
    expect(container.querySelector('input, button')).toBeTruthy();
  });

  it('parses and mounts every migrated fixture through the same renderer', async () => {
    for (const program of gallerySections.flatMap(section => section.programs)) {
      const app = galleryProgramToApp(program);
      const errors: string[] = [];
      await act(async () => root.render(<GenUIOpenUIDocument
        source={app.source}
        library={genUIProduct.libraries[app.libraryId]}
        toolProvider={program.requiresTools ? galleryToolProvider : undefined}
        onError={next => errors.push(...next.map(error => error.message))}
      />));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(errors, program.id).toEqual([]);
      expect(container.querySelector('[data-openbitfun-component]'), program.id).toBeTruthy();
    }
  });
});
