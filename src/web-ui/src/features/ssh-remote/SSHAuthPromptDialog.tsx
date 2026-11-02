/**
 * Unified SSH authentication prompt.
 */

import {
  Button,
  Field,
  Disclosure,
  Icon,
  IconButton,
  Input,
  Select,
  Tooltip,
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

import { FolderOpen, Key, Loader2, Lock } from 'lucide-react';
import type { SSHAuthMethod } from './types';
import {
  pickSshCertificatePath,
  pickSshPrivateKeyPath,
} from './pickSshPrivateKeyPath';
import './SSHAuthPromptDialog.scss';

export interface SSHAuthPromptSubmitPayload {
  auth: SSHAuthMethod;
  /** When username is editable, the value from the dialog */
  username: string;
}

interface SSHAuthPromptDialogProps {
  open: boolean;
  /** Shown in the header area (e.g. user@host:port or alias) */
  targetDescription: string;
  defaultAuthMethod: 'password' | 'privateKey' | 'agent' | 'keyboardInteractive';
  defaultKeyPath?: string;
  defaultCertificatePath?: string;
  initialUsername: string;
  /** If false, user can edit username (e.g. SSH config without User) */
  lockUsername: boolean;
  /** Saved profiles only need missing credentials; connection settings remain optional. */
  credentialsOnly?: boolean;
  isConnecting?: boolean;
  onSubmit: (payload: SSHAuthPromptSubmitPayload) => void;
  onCancel: () => void;
}

export const SSHAuthPromptDialog: React.FC<SSHAuthPromptDialogProps> = ({
  open,
  targetDescription,
  defaultAuthMethod,
  defaultKeyPath = '~/.ssh/id_rsa',
  defaultCertificatePath = '',
  initialUsername,
  lockUsername,
  credentialsOnly = false,
  isConnecting = false,
  onSubmit,
  onCancel,
}) => {
  const { t } = useI18n('common');
  const [authMethod, setAuthMethod] = useState<
    'password' | 'privateKey' | 'agent' | 'keyboardInteractive'
  >(defaultAuthMethod);
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState('');
  const [keyPath, setKeyPath] = useState(defaultKeyPath);
  const [passphrase, setPassphrase] = useState('');
  const [certificatePath, setCertificatePath] = useState(defaultCertificatePath);
  const [verificationCode, setVerificationCode] = useState('');
  const [showAuthSettings, setShowAuthSettings] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setPassword('');
      setPassphrase('');
      setVerificationCode('');
      return;
    }
    setShowAuthSettings(false);
    setAuthMethod(defaultAuthMethod);
    setUsername(initialUsername);
    setPassword('');
    setKeyPath(defaultKeyPath);
    setPassphrase('');
    setCertificatePath(defaultCertificatePath);
    setVerificationCode('');
    const focusMs = window.setTimeout(() => {
      if (defaultAuthMethod === 'password' || defaultAuthMethod === 'keyboardInteractive'
        || (credentialsOnly && defaultAuthMethod === 'privateKey')) {
        passwordRef.current?.focus();
      }
    }, 100);
    return () => window.clearTimeout(focusMs);
  }, [open, defaultAuthMethod, defaultKeyPath, defaultCertificatePath, initialUsername, credentialsOnly]);

  const authOptions = [
    { label: t('ssh.remote.password') || 'Password', value: 'password', icon: <Lock size={14} /> },
    { label: t('ssh.remote.privateKey') || 'Private Key', value: 'privateKey', icon: <Key size={14} /> },
    { label: t('ssh.remote.sshAgent'), value: 'agent', icon: <Key size={14} /> },
    {
      label: t('ssh.remote.keyboardInteractive'),
      value: 'keyboardInteractive',
      icon: <Lock size={14} />,
    },
  ];

  const canSubmit = (): boolean => {
    const u = username.trim();
    if (!u) return false;
    if (authMethod === 'password') return password.length > 0;
    if (authMethod === 'privateKey') return keyPath.trim().length > 0;
    if (authMethod === 'keyboardInteractive') {
      return password.length > 0 || verificationCode.length > 0;
    }
    return true;
  };

  const handleSubmit = () => {
    if (!canSubmit() || isConnecting) return;
    const u = username.trim();
    let auth: SSHAuthMethod;
    if (authMethod === 'password') {
      auth = { type: 'Password', password };
    } else if (authMethod === 'privateKey') {
      auth = {
        type: 'PrivateKey',
        keyPath: keyPath.trim(),
        passphrase: passphrase.trim() || undefined,
        certificatePath: certificatePath.trim() || undefined,
      };
    } else if (authMethod === 'agent') {
      auth = { type: 'Agent' };
    } else {
      auth = {
        type: 'KeyboardInteractive',
        responses: [password, verificationCode].filter(Boolean),
      };
    }
    onSubmit({ auth, username: u });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && canSubmit() && !isConnecting) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === 'Escape') {
      onCancel();
    }
  };

  const handleBrowsePrivateKey = useCallback(async () => {
    if (isConnecting) return;
    const path = await pickSshPrivateKeyPath({
      title: t('ssh.remote.pickPrivateKeyDialogTitle'),
    });
    if (path) setKeyPath(path);
  }, [isConnecting, t]);

  const handleBrowseCertificate = useCallback(async () => {
    if (isConnecting) return;
    const path = await pickSshCertificatePath({
      title: t('ssh.remote.pickCertificateDialogTitle'),
    });
    if (path) setCertificatePath(path);
  }, [isConnecting, t]);

  const authenticationSettings = (
    <>
      <div className="ssh-auth-prompt-dialog__field" data-openbitfun-component="ssh-remote" data-openbitfun-part="authField">
        <Field label={t('ssh.remote.authMethod')} controlWidth="fill">
          <Select
            options={authOptions}
            value={authMethod}
            onValueChange={(value) => setAuthMethod(
              value as 'password' | 'privateKey' | 'agent' | 'keyboardInteractive',
            )}
            size="md"
            disabled={isConnecting}
          />
        </Field>
      </div>
      {authMethod === 'privateKey' && (
        <>
          <div className="ssh-auth-prompt-dialog__field">
            <Field label={t('ssh.remote.privateKeyPath')} controlWidth="fill">
              <Input
                size="md"
                value={keyPath}
                onChange={(e) => setKeyPath(e.target.value)}
                placeholder="~/.ssh/id_rsa"
                leading={<Key size={16} />}
                trailing={
                  <Tooltip content={t('ssh.remote.browsePrivateKey')}>
                    <IconButton
                      type="button"
                      size="sm"
                      className="ssh-auth-prompt-dialog__browse-key"
                      aria-label={t('ssh.remote.browsePrivateKey')}
                      disabled={isConnecting}
                      onClick={() => void handleBrowsePrivateKey()}
                      icon={<FolderOpen size={16} />}
                    />
                  </Tooltip>
                }
                disabled={isConnecting}
              />
            </Field>
          </div>
          <div className="ssh-auth-prompt-dialog__field">
            <Field label={t('ssh.remote.certificatePath')} controlWidth="fill">
              <Input
                size="md"
                value={certificatePath}
                onChange={(e) => setCertificatePath(e.target.value)}
                placeholder={t('ssh.remote.certificatePathOptional')}
                trailing={
                  <Tooltip content={t('ssh.remote.browseCertificate')}>
                    <IconButton
                      type="button"
                      size="sm"
                      className="ssh-auth-prompt-dialog__browse-key"
                      aria-label={t('ssh.remote.browseCertificate')}
                      disabled={isConnecting}
                      onClick={() => void handleBrowseCertificate()}
                      icon={<FolderOpen size={16} />}
                    />
                  </Tooltip>
                }
                disabled={isConnecting}
              />
            </Field>
          </div>
        </>
      )}
    </>
  );

  return (
    <Dialog
      open={open}
      initialFocusRef={credentialsOnly ? passwordRef : undefined}
      onOpenChange={(nextOpen) => { if (!nextOpen) onCancel(); }}
      size="lg"
      className="ssh-auth-prompt-dialog__surface"
    >
      <DialogHeader>
        <DialogHeading>
          <DialogTitle>
            {t('ssh.remote.authPromptTitle') || 'SSH authentication'}
            {targetDescription && <span data-openbitfun-component="ssh-remote" data-openbitfun-part="authDescription"> · {targetDescription}</span>}
          </DialogTitle>
        </DialogHeading>
        <DialogClose />
      </DialogHeader>
      <DialogBody className="ssh-auth-prompt-dialog__body">
      <div className="ssh-auth-prompt-dialog" onKeyDown={handleKeyDown} data-openbitfun-component="ssh-remote" data-openbitfun-part="authDialog">
        {!lockUsername && (
          <div className="ssh-auth-prompt-dialog__field" data-openbitfun-component="ssh-remote" data-openbitfun-part="authField">
            <Field label={t('ssh.remote.username')} controlWidth="fill">
              <Input size="md" value={username} onChange={event => setUsername(event.target.value)}
                placeholder="root" leading={<Icon name="user" size="md" />} disabled={isConnecting} />
            </Field>
          </div>
        )}
        {credentialsOnly ? (
          <Disclosure className="ssh-auth-prompt-dialog__advanced"
            contentInnerClassName="ssh-auth-prompt-dialog__advanced-content"
            summary={t('workspaceSource.authenticationSettings')}
            open={showAuthSettings} onOpenChange={setShowAuthSettings} disabled={isConnecting} unmountOnClose>
            {authenticationSettings}
          </Disclosure>
        ) : authenticationSettings}

        {authMethod === 'password' && (
          <div className="ssh-auth-prompt-dialog__field">
            <Field label={t('ssh.remote.password')} controlWidth="fill">
              <Input
                size="md"
                ref={passwordRef}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                leading={<Lock size={16} />}
                disabled={isConnecting}
              />
            </Field>
          </div>
        )}

        {authMethod === 'privateKey' && (
            <div className="ssh-auth-prompt-dialog__field">
              <Field label={t('ssh.remote.passphrase')} controlWidth="fill">
                <Input ref={passwordRef}
                  size="md"
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder={t('ssh.remote.passphraseOptional')}
                  disabled={isConnecting}
                />
              </Field>
            </div>
        )}

        {authMethod === 'keyboardInteractive' && (
          <>
            <div className="ssh-auth-prompt-dialog__field">
              <Field label={t('ssh.remote.challengePassword')} controlWidth="fill">
                <Input
                  size="md"
                  ref={passwordRef}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  leading={<Lock size={16} />}
                  disabled={isConnecting}
                />
              </Field>
            </div>
            <div className="ssh-auth-prompt-dialog__field">
              <Field label={t('ssh.remote.verificationCode')} controlWidth="fill">
                <Input
                  size="md"
                  type="password"
                  value={verificationCode}
                  onChange={(e) => setVerificationCode(e.target.value)}
                  placeholder={t('ssh.remote.optional')}
                  disabled={isConnecting}
                />
              </Field>
            </div>
          </>
        )}

      </div>
      </DialogBody>
      <DialogFooter
        separator
        className="ssh-auth-prompt-dialog__actions"
        data-openbitfun-component="ssh-remote"
        data-openbitfun-part="authActions"
      >
          <Button variant="fill" size="sm" onClick={onCancel} disabled={isConnecting}>
            {t('actions.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleSubmit}
            disabled={!canSubmit() || isConnecting}
          >
            {isConnecting ? (
              <>
                <Loader2 size={14} className="ssh-auth-prompt-dialog__spinner" />
                {t('ssh.remote.connecting')}
              </>
            ) : (
              t('ssh.remote.connect')
            )}
          </Button>
      </DialogFooter>
    </Dialog>
  );
};

export default SSHAuthPromptDialog;
