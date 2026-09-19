/**
 * Terminal edit modal
 * Supports editing terminal name and startup command
 */

import {
  Button,
  Field,
  Input,
  Dialog,
  DialogBody,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogHeading,
  DialogTitle,
} from '@openbitfun/ui';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import './TerminalEditModal.scss';

export interface TerminalEditModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (input: { name: string; workingDirectory?: string; startupCommand?: string }) => void;
  initialName: string;
  initialWorkingDirectory?: string;
  initialStartupCommand?: string;
  showWorkingDirectory?: boolean;
  showStartupCommand?: boolean;
}

export const TerminalEditModal: React.FC<TerminalEditModalProps> = ({
  isOpen,
  onClose,
  onSave,
  initialName,
  initialWorkingDirectory = '',
  initialStartupCommand = '',
  showWorkingDirectory = true,
  showStartupCommand = true,
}) => {
  const { t } = useI18n('panels/terminal');
  const { t: tCommon } = useI18n('common');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [name, setName] = useState(initialName);
  const [workingDirectory, setWorkingDirectory] = useState(initialWorkingDirectory);
  const [startupCommand, setStartupCommand] = useState(initialStartupCommand);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setSaveError(null);
      setName(initialName);
      setWorkingDirectory(initialWorkingDirectory);
      setStartupCommand(initialStartupCommand);
      setTimeout(() => {
        nameInputRef.current?.focus();
        nameInputRef.current?.select();
      }, 100);
    }
  }, [initialName, initialStartupCommand, initialWorkingDirectory, isOpen]);



  const handleSave = useCallback(() => {
    const trimmedName = name.trim();
    if (!trimmedName) return;

    const trimmedWorkingDirectory = workingDirectory.trim();
    const trimmedCommand = startupCommand.trim();
    setSaveError(null);
    try {
      onSave({
        name: trimmedName,
        workingDirectory: trimmedWorkingDirectory || undefined,
        startupCommand: trimmedCommand || undefined,
      });
      onClose();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  }, [name, onClose, onSave, startupCommand, workingDirectory]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSave();
    }
  }, [handleSave]);

  const canSave = name.trim().length > 0;

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}
      size="sm"
    >
      <DialogHeader>
        <DialogHeading>
          <DialogTitle>{t('dialog.editTerminal.title')}</DialogTitle>
        </DialogHeading>
        <DialogClose />
      </DialogHeader>
      <DialogBody>
      <div data-openbitfun-component="terminal-edit-modal" data-openbitfun-part="content" className="terminal-edit-dialog__content">
        <Field label={t('dialog.editTerminal.nameLabel')}>
          <Input
            ref={nameInputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('dialog.editTerminal.namePlaceholder')}
          />
        </Field>

        {showWorkingDirectory ? (
          <Field
            description={t('dialog.editTerminal.workingDirectoryHint')}
            label={t('dialog.editTerminal.workingDirectoryLabel')}
          >
            <Input
              value={workingDirectory}
              onChange={(e) => setWorkingDirectory(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('dialog.editTerminal.workingDirectoryPlaceholder')}
            />
          </Field>
        ) : null}

        {showStartupCommand ? (
          <Field
            description={t('dialog.editTerminal.startupCommandHint')}
            label={t('dialog.editTerminal.startupCommandLabel')}
          >
            <Input
              value={startupCommand}
              onChange={(e) => setStartupCommand(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('dialog.editTerminal.startupCommandPlaceholder')}
            />
          </Field>
        ) : null}
        {saveError && <p role="alert" className="terminal-edit-dialog__error"
          data-openbitfun-component="terminal-edit-modal" data-openbitfun-part="error">
          {tCommon('nav.resources.actionFailed', { error: saveError })}
        </p>}
      </div>
      </DialogBody>
      <DialogFooter
        separator
        data-openbitfun-component="terminal-edit-modal"
        data-openbitfun-part="footer"
        className="terminal-edit-dialog__footer"
      >
        <Button variant="fill" onClick={onClose}>
          {t('dialog.editTerminal.cancel')}
        </Button>
        <Button variant="primary" onClick={handleSave} disabled={!canSave}>
          {t('dialog.editTerminal.save')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
};

export default TerminalEditModal;
