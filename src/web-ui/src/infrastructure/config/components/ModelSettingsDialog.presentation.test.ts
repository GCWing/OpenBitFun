import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const source = readFileSync(
  fileURLToPath(new URL('../../../app/scenes/settings/pages/ai/ModelSettingsPage.tsx', import.meta.url)),
  'utf8',
);
const styles = readFileSync(
  fileURLToPath(new URL('../../../app/scenes/settings/pages/ai/ModelSettingsPage.scss', import.meta.url)),
  'utf8',
);

describe('ModelSettingsPage dialog presentation', () => {
  it('uses a content-sized editor and panel dialogs for model browsing workflows', () => {
    const owners = [
      '../../../app/scenes/settings/pages/ai/ModelSettingsPage.tsx',
      '../../../app/scenes/settings/pages/ai/ModelDiscoveryPicker.tsx',
      '../../../app/scenes/settings/pages/ai/ModelPoolsSection.tsx',
      '../../../app/scenes/settings/pages/ai/ModelPoolMemberPicker.tsx',
      './ModelRouterSettings.tsx',
      './image-generation/ImageGenerationEditor.tsx',
    ];
    for (const owner of owners) {
      const content = readFileSync(fileURLToPath(new URL(owner, import.meta.url)), 'utf8');
      const tree = ts.createSourceFile(owner, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      let dialogs = 0;
      const visit = (node: ts.Node) => {
        if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(tree) === 'Dialog') {
          const preset = node.attributes.properties.find(property => ts.isJsxAttribute(property) && property.name.getText(tree) === 'preset');
          const editor = node.attributes.properties.some(property => ts.isJsxAttribute(property)
            && property.name.getText(tree) === 'className'
            && property.initializer?.getText(tree) === '"openbitfun-model-settings__editor-dialog"');
          expect(preset?.getText(tree), owner).toBe(editor ? 'preset="default"' : 'preset="panel"');
          dialogs += 1;
        }
        ts.forEachChild(node, visit);
      };
      visit(tree);
      expect(dialogs, owner).toBeGreaterThan(0);
    }
  });

  it('keeps model configuration editors at a moderate responsive size', () => {
    const editorDialogStart = source.indexOf('open={isEditing && !!editingConfig}');
    const editorDialog = source.slice(editorDialogStart, source.indexOf('<ConfirmDialog', editorDialogStart));
    const editingFormStart = source.indexOf('const renderEditingForm = () => {');
    const editingForm = source.slice(
      editingFormStart,
      source.indexOf('const renderModelCollectionItem', editingFormStart),
    );

    expect(editorDialogStart).toBeGreaterThan(-1);
    expect(editingFormStart).toBeGreaterThan(-1);
    expect(editorDialog).toContain('className="openbitfun-model-settings__editor-dialog"');
    expect(editorDialog).toContain('preset="default"');
    expect(editorDialog).toContain('size="lg"');
    expect(editorDialog).toContain('<DialogHeaderLeading>');
    expect(editorDialog).toContain('<DialogHeaderActions>');
    expect(editorDialog).not.toContain('size="2xl"');
    expect(editorDialog).toMatch(
      /\{!reasoningPanelDraft && \(\s*<DialogFooter>/,
    );
    expect(editorDialog).not.toContain('appearance="floating"');
    expect(editorDialog).toContain(
      '<Button variant="fill" size="sm" onClick={modelPanelDraft ? cancelModelPanel : requestCloseEditingModal} disabled={isEditorSaving}>',
    );
    expect(editorDialog).toMatch(
      /<Button\s+data-testid="settings-model-save-btn"\s+variant="primary"\s+size="sm"/,
    );
    expect(editorDialog).toContain('<DialogClose disabled={isEditorSaving || !!(managingSubscriptionProvider && loggingInProvider)} />');
    expect(editorDialog).toContain('loading={isEditorSaving}');
    expect(editingForm.match(/fieldSurface="filled"/g)).toHaveLength(4);
    expect(editingForm).not.toContain('<ScrollArea');
    expect(editingForm).toContain('className="openbitfun-model-settings__form-content"');
    expect(editorDialog).not.toContain('openbitfun-model-settings__editor-dialog-footer');
    expect(editorDialog).not.toContain('openbitfun-model-settings__editor-dialog-cancel');
    expect(styles).not.toMatch(/&__(?:editor-dialog|subscription-dialog|model-discovery-dialog)\s*\{/);
    expect(styles).not.toContain('&__editor-dialog-footer');
    expect(styles).not.toContain('&__editor-dialog-cancel');
    expect(styles).toMatch(/&__selected-models-list\s*{\s*display:\s*flex;\s*flex-wrap:\s*wrap;/);
    expect(styles).toMatch(/&__model-capsule\s*{[\s\S]*?width:\s*auto;/);
  });

  it('keeps unsaved editor state behind an explicit draft decision', () => {
    expect(source).toContain('if (editingModalHasUnsavedChanges) {');
    expect(source).toContain('setDraftCloseConfirmOpen(true);');
    expect(source).toContain('onConfirm={preserveEditingDraftAndClose}');
    expect(source).toContain('onSecondary={discardEditingDraftAndClose}');
    expect(source).toContain("confirmText={t('draftClose.keepAndClose')}");
    expect(source).toContain("cancelText={t('draftClose.continueEditing')}");
    expect(source).toContain("statusMessage={t('draftClose.retainedHint')}");
  });

  it('protects a retained draft when another editor target is requested', () => {
    expect(source).toContain('pendingEditorOpenRef.current = { open };');
    expect(source).toContain('onConfirm={continueEditingCurrentDraft}');
    expect(source).toContain('onSecondary={discardDraftBeforeOpeningPendingEditor}');
  });

  it('offers atomic provider deletion with provider-specific confirmation', () => {
    expect(source).toContain("<Tooltip content={t('actions.deleteProvider')}>");
    expect(source).toContain('onClick={() => void requestProviderDelete(group)}');
    expect(source).toContain("kind: 'provider',");
    expect(source).toContain('removeProviderModelConfigs(current, request.groupKey)');
    expect(source).toContain("? 'providerDeleteConfirm.title'");
    expect(source).toContain("? 'providerDeleteConfirm.confirm'");
  });
});
