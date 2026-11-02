import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function readChatInputComponent(): string {
  return readFileSync(fileURLToPath(new URL('./ChatInput.tsx', import.meta.url)), 'utf8')
    .replace(/\r\n/g, '\n');
}

describe('composer image file intake', () => {
  const component = readChatInputComponent();

  it.each([
    ['handleSendOrCancel', 'submittedContexts', 'clearComposerForSubmission'],
    ['submitBtwFromInput', 'imagesForBtw', "dispatchInput({ type: 'CLEAR_VALUE'"],
    ['submitMcpPromptFromInput', 'submittedContexts', 'clearComposerForSubmission'],
    ['submitExternalPromptCommandFromInput', 'contexts', "dispatchInput({ type: 'CLEAR_VALUE'"],
  ])('keeps an over-limit draft intact in %s after switching models', (entry, snapshot, clear) => {
    const start = component.indexOf(`const ${entry} = useCallback(`);
    expect(start).toBeGreaterThan(-1);
    const body = component.slice(start, component.indexOf('  }, [', start));
    const admission = body.indexOf(`if (!admitComposerImages(${snapshot})) return`);
    expect(admission).toBeGreaterThan(-1);
    expect(body.indexOf(clear)).toBeGreaterThan(admission);
  });

  it('mounts the picker before clicking it so WebKitGTK delivers change', () => {
    // WebKitGTK (the Linux webview) never fires `change` on a detached file
    // input after the native chooser closes, which silently dropped every
    // "Add image" selection on Linux. The picker must therefore be appended to
    // the document before `input.click()`.
    expect(component).toMatch(
      /const handleImageInput = useCallback\(\(\) => \{[\s\S]*?document\.body\.appendChild\(input\);\s*\n\s*input\.click\(\);/,
    );
  });

  it('hides the mounted picker offscreen instead of display:none', () => {
    expect(component).toContain("input.style.position = 'fixed'");
    expect(component).toContain("input.style.left = '-9999px'");
    // Some WebKit builds refuse to open a chooser for a display:none input,
    // so the mounted picker must stay rendered, just offscreen.
    expect(component).not.toContain("input.style.display = 'none'");
  });

  it('reclaims the picker on both the change and the cancel path', () => {
    // Selecting a file must release the node before the async intake loop.
    expect(component).toMatch(
      /input\.onchange = async \(e\) => \{\s*\n\s*dismissPicker\(\);/,
    );
    // Cancelling the chooser never fires `change`; the one-shot focus listener
    // is the only reclaim for that path.
    expect(component).toContain("window.addEventListener('focus', dismissPicker);");
    expect(component).toMatch(
      /const dismissPicker = \(\) => \{\s*\n\s*window\.removeEventListener\('focus', dismissPicker\);\s*\n\s*input\.onchange = null;\s*\n\s*input\.remove\(\);/,
    );
  });

  it('falls back to a host clipboard read for empty-typed pastes', () => {
    // WebKitGTK fires paste with zero DataTransfer types, so the composer must
    // listen for paste directly and ask the host for the clipboard image.
    expect(component).toContain('shouldAttemptNativeClipboardImageRead(types)');
    expect(component).toMatch(
      /inputElement\.addEventListener\('paste', handlePasteFallback\);/,
    );
    expect(component).toMatch(
      /const image = await workspaceAPI\.getClipboardImage\(\);/,
    );
  });

  it('reads clipboard files first and widens the type gate on Linux', () => {
    // A copied file arrives as a text/uri-list target on WebKitGTK, so an
    // empty-types-only gate dropped every file paste.
    expect(component).toContain('if (!emptyTyped && !isLinuxDesktopRuntime()) return;');
    expect(component).toMatch(
      /if \(await readPastedClipboardFiles\(request\)\) return;[\s\S]{0,240}?if \(!emptyTyped\) return;/,
    );
  });
});
