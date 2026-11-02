/**
 * SSH Connection Dialog Component
 * Professional SSH connection dialog following OpenBitFun design patterns
 */

import { OverflowText,
  Capsule,
  Button,
  Field,
  FieldGroup,
  FieldRow,
  FormSection,
  Icon,
  IconButton,
  Input as DesignInput,
  Combobox,
  Disclosure,
  NumberInput,
  SearchField,
  ScrollArea,
  Select,
  TabGroup,
  Tooltip,
  Dialog,
  DialogBody,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogHeading,
  DialogTitle,
} from '@openbitfun/ui';
import React, { useState, useEffect, useCallback, useRef, useId, useSyncExternalStore } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { useSSHRemoteContext } from './SSHRemoteContext';
import { SSHAuthPromptDialog, type SSHAuthPromptSubmitPayload } from './SSHAuthPromptDialog';
import { EyeOff, FolderOpen, Key, Loader2, Lock, Server } from 'lucide-react';
import type {
  ConnectionTestReport,
  ConnectionTestStage,
  DockerContainerInfo,
  SSHConnectionConfig,
  WslDistributions,
  SSHAuthMethod,
  SavedConnection,
  SSHConfigEntry,
  WorkspaceConnectionTarget,
} from './types';
import { sshApi } from './sshApi';
import { WorkspaceSourceSelector } from './WorkspaceSourceSelector';
import { WorkspaceChoiceCapsules } from './WorkspaceChoiceCapsules';
import { workspaceSourceErrorKey, isSshAuthenticationError } from './workspaceSourceError';
import { savedConnectionConfig } from './savedConnectionConfig';
import type { WorkspaceConnectionPreset } from './useWorkspaceSourceOptions';
import { sameWorkspaceSource, savedConnectionTarget } from './workspaceSource';
import {
  pickSshCertificatePath,
  pickSshPrivateKeyPath,
} from './pickSshPrivateKeyPath';
import { getMotionAwareScrollBehavior } from '@/shared/utils/motionPreference';
import './SSHConnectionDialog.scss';

interface SSHConnectionDialogProps {
  open: boolean;
  onClose: () => void;
  initialTargetType?: WorkspaceConnectionTarget;
  /** Project creation has already chosen location and environment. */
  fixedSource?: boolean;
  confirmLabel?: string;
  initialPreset?: WorkspaceConnectionPreset;
  browseAfterConnect?: boolean;
  onConnected?: (config: SSHConnectionConfig, connectionId: string) => void;
}

const emptySshEndpoint = () => ({
  host: '', port: '22', username: '',
  authType: 'password' as 'password' | 'privateKey' | 'agent' | 'keyboardInteractive',
  password: '', keyPath: '~/.ssh/id_rsa', passphrase: '', certificatePath: '',
  keyFingerprint: '', fallbackKeyPath: '~/.ssh/id_rsa', verificationCode: '', proxyJump: '',
});
const sshEndpointOwner = (target: WorkspaceConnectionTarget) => target === 'wsl' || target === 'localDocker'
  ? null : target === 'containerSshd' ? 'container' : 'host';

export const SSHConnectionDialog: React.FC<SSHConnectionDialogProps> = ({
  open,
  onClose,
  initialTargetType = 'ssh',
  fixedSource = false,
  confirmLabel,
  initialPreset,
  browseAfterConnect = true,
  onConnected,
}) => {
  const { t } = useI18n('common');
  const peer = usePeerDeviceModeOptional();
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const { connect, status, connectionError, clearError } = useSSHRemoteContext();
  const [savedConnections, setSavedConnections] = useState<SavedConnection[]>([]);
  const [sshConfigHosts, setSSHConfigHosts] = useState<SSHConfigEntry[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [credentialsPrompt, setCredentialsPrompt] = useState<SavedConnection | null>(null);
  const [savedSearch, setSavedSearch] = useState('');
  const [configSearch, setConfigSearch] = useState('');
  const [connectionView, setConnectionView] = useState<'saved' | 'new'>('saved');
  const [selectedConnectionId, setSelectedConnectionId] = useState<string>();
  const [editingPreset, setEditingPreset] = useState<WorkspaceConnectionPreset>();
  const [editingProfile, setEditingProfile] = useState<SavedConnection>();
  const savedRequestId = useRef(0);
  const appliedPreset = useRef<WorkspaceConnectionPreset>();
  const editOnly = initialPreset?.edit === true;
  const [containerHost, setContainerHost] = useState<SavedConnection>();
  const connectionViewId = useId();
  const [isTesting, setIsTesting] = useState(false);
  const [isListingContainers, setIsListingContainers] = useState(false);
  const [connectionTest, setConnectionTest] = useState<ConnectionTestReport | null>(null);
  const [dockerContainers, setDockerContainers] = useState<DockerContainerInfo[]>([]);
  const containerRequestId = useRef(0);

  const [wslDistributions, setWslDistributions] = useState<WslDistributions | null>(null);
  const [wslError, setWslError] = useState<string | null>(null);
  const [isListingWsl, setIsListingWsl] = useState(false);
  const [wslRefresh, setWslRefresh] = useState(0);



  // Form state
  const [formData, setFormData] = useState({
    ...emptySshEndpoint(),
    targetType: initialTargetType,
    name: '',
    wslDistribution: '',
    wslUser: '',
    containerName: '',
    containerAccess: 'auto' as 'auto' | 'docker-exec',
    dockerPath: 'docker',
    containerShell: '/bin/sh',
    containerUser: '',
    connectTimeoutSecs: '30',
    authTimeoutSecs: '60',
    authAttempts: '3',
    connectAttempts: '1',
  });
  const inheritedHost = formData.targetType === 'remoteDocker';
  const parentHost = initialPreset?.kind === 'new' ? initialPreset.host : undefined;
  const hostIsFixed = inheritedHost && (Boolean(parentHost) || editOnly);
  const error = localError || (connectionError ? t('workspaceSource.connectionFailed') : null);
  const connectAndFinish = useCallback(async (config: SSHConnectionConfig) => {
    const result = await connect(config.id, config, { browseAfterConnect });
    scope.assertCurrent('finish connecting workspace source');
    onConnected?.(config, result?.connectionId || config.id);
    onClose();
  }, [connect, browseAfterConnect, scope, onConnected, onClose]);
  // Host and container SSH endpoints have separate addresses and credentials.
  const endpointDrafts = useRef<Partial<Record<'host' | 'container', ReturnType<typeof emptySshEndpoint>>>>({});
  const usesSshEndpoint = sshEndpointOwner(formData.targetType) !== null;
  const currentHost = peer?.peerMode.active
    ? t('workspaceSource.namedHost', { name: peer.peerMode.deviceName })
    : t('workspaceSource.currentHost');
  const connectionTitle = editOnly ? t('workspaceSource.editConnectionTitle', { name: formData.name })
    : !fixedSource ? t('workspaceSource.connectionTitle')
    : formData.targetType === 'ssh' ? t('workspaceSource.connectRemoteHostTitle')
    : formData.targetType === 'wsl' ? t('workspaceSource.connectWslTitle', { host: currentHost })
    : formData.targetType === 'localDocker' ? t('workspaceSource.connectContainerTitle', { host: currentHost })
    : inheritedHost && parentHost ? t('workspaceSource.connectContainerTitle', { host: parentHost.name })
    : t('workspaceSource.connectRemoteContainerTitle');

  const [showPassword, setShowPassword] = useState(false);
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);

  const scrollToConnectionForm = useCallback(() => {
    const el = formRef.current;
    if (!el) return;
    el.scrollIntoView({
      behavior: getMotionAwareScrollBehavior('smooth'),
      block: 'start',
    });
  }, []);

  const loadSavedConnections = useCallback(async () => {
    const requestId = ++savedRequestId.current;
    setLocalError(null);
    try {
      const connections = await sshApi.listSavedConnections();
      if (requestId === savedRequestId.current && scope.isCurrent()) setSavedConnections(connections);
    } catch (_error) {
      if (requestId === savedRequestId.current && scope.isCurrent()) setLocalError(t('workspaceSource.hostDiscoveryFailed'));
    }
  }, [scope, t]);

  // Clear errors when dialog opens
  useEffect(() => {
    containerRequestId.current += 1;
    setIsListingContainers(false);
    setCredentialsPrompt(null);
    if (open) {
      clearError();
      setLocalError(null);
      setShowAdvancedSettings(false);
      setSavedSearch('');
      setConfigSearch('');
      setConnectionView('saved');
      setSelectedConnectionId(undefined);
      setEditingProfile(undefined);
      setContainerHost(undefined);
      setEditingPreset(undefined);
      setConnectionTest(null);
      setDockerContainers([]);
      endpointDrafts.current = {};
      setFormData(prev => ({
        ...prev,
        ...(sshEndpointOwner(prev.targetType) !== sshEndpointOwner(initialTargetType) ? emptySshEndpoint() : {}),
        targetType: initialTargetType,
      }));
      void loadSavedConnections();
    }
  }, [open, clearError, initialTargetType, loadSavedConnections]);

  useEffect(() => {
    if (!open || !usesSshEndpoint || inheritedHost) {
      setSSHConfigHosts([]);
      return;
    }
    let cancelled = false;
    sshApi.listSSHConfigHosts().then(hosts => {
      if (!cancelled && scope.isCurrent()) setSSHConfigHosts(hosts);
    }).catch(error => {
      if (cancelled || !scope.isCurrent()) return;
      console.error('Failed to load SSH config hosts:', error);
      setSSHConfigHosts([]);
    });
    return () => { cancelled = true; };
  }, [open, usesSshEndpoint, inheritedHost, scope]);

  useEffect(() => {
    if (!open || formData.targetType !== 'wsl') return;
    let cancelled = false;
    setIsListingWsl(true);
    setWslDistributions(null);
    setWslError(null);
    sshApi.listWslDistributions().then((result) => {
      if (cancelled || !scope.isCurrent()) return;
      setWslDistributions(result);
      setFormData((prev) => ({
        ...prev,
        wslDistribution: prev.wslDistribution || result.distributions[0] || '',
      }));
    }).catch(() => {
      if (!cancelled && scope.isCurrent()) setWslError(t('ssh.remote.wslDiscoveryFailed'));
    }).finally(() => {
      if (!cancelled && scope.isCurrent()) setIsListingWsl(false);
    });
    return () => { cancelled = true; };
  }, [open, formData.targetType, wslRefresh, t, scope]);

  useEffect(() => {
    if (!open || formData.targetType !== 'localDocker') return;
    let cancelled = false;
    setIsListingContainers(true);
    void sshApi.listDockerContainers({
      id: 'docker-local-discovery', name: 'Docker', host: 'localhost', port: 22,
      username: 'docker', auth: { type: 'PrivateKey', keyPath: '' },
      container: { name: 'discovery', local: true, access: 'auto', dockerPath: 'docker', shell: '/bin/sh', interactive: true },
    }).then(containers => {
      if (!cancelled && scope.isCurrent()) setDockerContainers(containers);
    }).catch(error => {
      if (!cancelled && scope.isCurrent()) setLocalError(t(workspaceSourceErrorKey(formData.targetType, error)));
    }).finally(() => { if (!cancelled && scope.isCurrent()) setIsListingContainers(false); });
    return () => { cancelled = true; };
  }, [open, formData.targetType, t, scope]);

  // Load SSH config from ~/.ssh/config when host changes
  useEffect(() => {
    if (!open || inheritedHost || !formData.host.trim() || formData.targetType === 'wsl' || formData.targetType === 'localDocker') return;
    let cancelled = false;

    const loadSSHConfig = async () => {
      try {
        const result = await sshApi.getSSHConfig(formData.host.trim());
        if (cancelled) return;
        if (result.found && result.config) {
          const config = result.config;
          if (config.proxyJump || config.certificateFile) {
            setShowAdvancedSettings(true);
          }
          // Auto-fill fields from SSH config if they're not already set
          setFormData((prev) => ({
            ...prev,
            port: config.port ? String(config.port) : prev.port,
            username: config.user || prev.username,
            keyPath: config.identityFile || prev.keyPath,
            certificatePath: config.certificateFile || prev.certificatePath,
            proxyJump: config.proxyJump || prev.proxyJump,
            authType: config.identityFile
              ? 'privateKey'
              : config.agent
                ? 'agent'
                : prev.authType,
          }));
        }
      } catch (e) {
        // Silently ignore SSH config errors
        console.debug('Failed to load SSH config:', e);
      }
    };

    // Debounce the SSH config lookup
    const timeout = setTimeout(loadSSHConfig, 300);
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [open, formData.host, formData.targetType, inheritedHost]);

  const handleInputChange = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    setConnectionTest(null);
    if (field === 'targetType' || field === 'host' || field === 'dockerPath') {
      setDockerContainers([]);
    }
  };

  const handleTargetChange = (targetType: WorkspaceConnectionTarget) => {
    containerRequestId.current += 1;
    setIsListingContainers(false);
    const previousOwner = sshEndpointOwner(formData.targetType);
    const nextOwner = sshEndpointOwner(targetType);
    let endpoint = {};
    if (previousOwner !== nextOwner) {
      const { host, port, username, authType, password, keyPath, passphrase, certificatePath,
        keyFingerprint, fallbackKeyPath, verificationCode, proxyJump } = formData;
      if (previousOwner) {
        endpointDrafts.current[previousOwner] = {
          host, port, username, authType, password, keyPath, passphrase, certificatePath,
          keyFingerprint, fallbackKeyPath, verificationCode, proxyJump,
        };
      }
      endpoint = (nextOwner && endpointDrafts.current[nextOwner]) || emptySshEndpoint();
    }
    setFormData(prev => ({ ...prev, ...endpoint, targetType }));
    setCredentialsPrompt(null);
    if (!sameWorkspaceSource(formData.targetType, targetType)) setConnectionView('saved');
    setConnectionTest(null);
    setDockerContainers([]);
    setLocalError(null);
    clearError();
  };

  const handleBrowsePrivateKey = useCallback(async () => {
    if (isConnecting || status === 'connecting') return;
    const path = await pickSshPrivateKeyPath({
      title: t('ssh.remote.pickPrivateKeyDialogTitle'),
    });
    if (path) setFormData((prev) => ({ ...prev, keyPath: path }));
  }, [isConnecting, status, t]);

  const handleBrowseCertificate = useCallback(async () => {
    if (isConnecting || status === 'connecting') return;
    const path = await pickSshCertificatePath({
      title: t('ssh.remote.pickCertificateDialogTitle'),
    });
    if (path) setFormData((prev) => ({ ...prev, certificatePath: path }));
  }, [isConnecting, status, t]);

  // Port is intentionally excluded so that the ID stays stable when the user
  // changes the SSH port.
  const generateConnectionId = (host: string, _port: number, username: string) => {
    return `ssh-${username}@${host}`;
  };

  const buildAuthMethod = (): SSHAuthMethod => {
    switch (formData.authType) {
      case 'password':
        return { type: 'Password', password: formData.password };
      case 'privateKey':
        return {
          type: 'PrivateKey',
          keyPath: formData.keyPath,
          passphrase: formData.passphrase || undefined,
          certificatePath: formData.certificatePath.trim() || undefined,
        };
      case 'agent':
        return {
          type: 'Agent',
          keyFingerprint: formData.keyFingerprint.trim() || undefined,
          fallbackKeyPath: formData.fallbackKeyPath.trim() || undefined,
        };
      case 'keyboardInteractive':
        return {
          type: 'KeyboardInteractive',
          responses: [formData.password, formData.verificationCode].filter(Boolean),
        };
    }
  };

  const buildConnectionConfig = async (
    requireContainer: boolean,
  ): Promise<SSHConnectionConfig | null> => {
    if (formData.targetType === 'wsl') {
      if (!editOnly && !wslDistributions?.supported) {
        setLocalError(wslError || t('ssh.remote.wslUnsupported'));
        return null;
      }
      const distribution = formData.wslDistribution.trim();
      if (!distribution || (!editOnly && !wslDistributions?.distributions.includes(distribution))) {
        setLocalError(t('ssh.remote.wslDistributionRequired'));
        return null;
      }
      const user = formData.wslUser.trim();
      return {
        id: editingProfile?.id ?? `wsl-${encodeURIComponent(distribution)}@${encodeURIComponent(user)}`,
        name: formData.name.trim() || `WSL · ${distribution}${user ? ` · ${user}` : ''}`,
        // Reserved, non-routable legacy SSH fields prevent older installs from
        // treating this additive profile as a usable SSH endpoint.
        host: 'wsl.invalid',
        port: 0,
        username: user,
        auth: { type: 'PrivateKey', keyPath: '' },
        wsl: { distribution, user: user || undefined },
        defaultWorkspace: editingProfile?.defaultWorkspace,
        options: editingProfile?.options,
      };
    }
    if (inheritedHost) {
      if (!containerHost) { setLocalError(t('workspaceSource.existingHostRequired')); return null; }
      if (requireContainer && !formData.containerName.trim()) { setLocalError(t('ssh.remote.containerRequired')); return null; }
      const containerName = formData.containerName.trim() || 'discovery';
      return { ...savedConnectionConfig(containerHost),
        id: !requireContainer ? initialPreset?.credentialConnectionId || containerHost.id : editingProfile?.id || `${containerHost.id}-container-${containerName}`,
        name: formData.name.trim() || containerName,
        defaultWorkspace: editingProfile?.defaultWorkspace,
        container: { name: containerName, local: false, access: formData.containerAccess, dockerPath: formData.dockerPath.trim() || 'docker',
          shell: formData.containerShell.trim() || '/bin/sh', user: formData.containerUser.trim() || undefined, interactive: true },
      };
    }
    const isLocalDocker = formData.targetType === 'localDocker';
    const usesContainer = formData.targetType !== 'ssh';
    if (!isLocalDocker && !formData.host.trim()) {
      setLocalError(t('ssh.remote.hostRequired'));
      return null;
    }
    if (!isLocalDocker && !formData.username.trim()) {
      setLocalError(t('ssh.remote.usernameRequired'));
      return null;
    }
    const portText = isLocalDocker ? '22' : formData.port.trim();
    const port = Number(portText);
    if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
      setLocalError(t('ssh.remote.portInvalid'));
      return null;
    }
    if (!isLocalDocker && formData.authType === 'password' && !formData.password && !editingProfile) {
      setLocalError(t('ssh.remote.passwordRequired'));
      return null;
    }
    if (!isLocalDocker && formData.authType === 'privateKey' && !formData.keyPath.trim()) {
      setLocalError(t('ssh.remote.keyPathRequired'));
      return null;
    }
    if (
      !isLocalDocker
      && !editOnly
      && formData.authType === 'keyboardInteractive'
      && !formData.password
      && !formData.verificationCode
    ) {
      setLocalError(t('ssh.remote.challengeResponseRequired'));
      return null;
    }
    if (usesContainer && formData.targetType !== 'containerSshd' && requireContainer && !formData.containerName.trim()) {
      setLocalError(t('ssh.remote.containerRequired'));
      return null;
    }
    const connectTimeoutSecs = Number(formData.connectTimeoutSecs);
    const authTimeoutSecs = Number(formData.authTimeoutSecs);
    const authAttempts = Number(formData.authAttempts);
    const connectAttempts = Number(formData.connectAttempts);
    if (
      !Number.isInteger(connectTimeoutSecs)
      || connectTimeoutSecs < 1
      || !Number.isInteger(authTimeoutSecs)
      || authTimeoutSecs < 1
      || !Number.isInteger(authAttempts)
      || authAttempts < 1
      || authAttempts > 10
      || !Number.isInteger(connectAttempts)
      || connectAttempts < 1
      || connectAttempts > 5
    ) {
      setShowAdvancedSettings(true);
      setLocalError(t('ssh.remote.connectionOptionsInvalid'));
      return null;
    }

    const hostInput = isLocalDocker ? 'local-docker' : formData.host.trim();
    let connectHost = hostInput;
    let resolvedProxyJump = formData.proxyJump.trim();
    if (!isLocalDocker) {
      try {
        const lookup = await sshApi.getSSHConfig(hostInput);
        const resolved = lookup.found && lookup.config?.hostname?.trim();
        if (resolved) {
          connectHost = resolved;
        }
        if (lookup.found && lookup.config?.proxyJump && !resolvedProxyJump) {
          resolvedProxyJump = lookup.config.proxyJump;
        }
      } catch {
        // Use the manual values if ~/.ssh/config cannot be read.
      }
    }

    const username = isLocalDocker
      ? (formData.username.trim() || 'docker')
      : formData.username.trim();
    // Direct SSH already identifies the container. Keep legacy metadata when editing;
    // new profiles derive it from the endpoint instead of asking for a Docker ID.
    const containerName = formData.containerName.trim() || (formData.targetType === 'containerSshd' ? connectHost : 'discovery');
    const id = isLocalDocker
      ? `docker-local-${containerName}`
      : `${generateConnectionId(connectHost, port, username)}${usesContainer ? `-container-${containerName}` : ''}`;
    return {
      id: editingProfile?.id ?? id,
      name: formData.name || (isLocalDocker ? containerName : `${username}@${hostInput}`),
      host: connectHost,
      port,
      username,
      auth: isLocalDocker
        ? { type: 'PrivateKey', keyPath: '' }
        : buildAuthMethod(),
      defaultWorkspace: editingProfile?.defaultWorkspace,
      proxyJump: !isLocalDocker ? resolvedProxyJump || undefined : undefined,
      container: usesContainer ? {
        name: containerName,
        access: formData.targetType === 'containerSshd'
          ? 'sshd'
          : formData.containerAccess,
        local: isLocalDocker,
        dockerPath: formData.dockerPath.trim() || 'docker',
        shell: formData.containerShell.trim() || '/bin/sh',
        user: formData.containerUser.trim() || undefined,
        interactive: true,
      } : undefined,
      options: {
        connectTimeoutSecs,
        authTimeoutSecs,
        authAttempts,
        connectAttempts,
      },
    };
  };

  const isWslTarget = formData.targetType === 'wsl';
  const isLocalProcessTarget = formData.targetType === 'localDocker' || isWslTarget;

  const handleConnect = async () => {
    setIsConnecting(true);
    setLocalError(null);
    try {
      const config = await buildConnectionConfig(true);
      if (!config) return;
      try { await connectAndFinish(config); } catch (cause) {
        if (inheritedHost && isSshAuthenticationError(cause)) {
          const { auth, ...profile } = config;
          setCredentialsPrompt({ ...profile, authType: auth.type === 'Password' ? { type: 'Password' }
            : auth.type === 'KeyboardInteractive' ? { type: 'KeyboardInteractive' } : auth });
        } else throw cause;
      }
    } catch (e) {
      setLocalError(t(isLocalProcessTarget || inheritedHost ? workspaceSourceErrorKey(formData.targetType, e) : 'workspaceSource.connectionFailed'));
    } finally {
      setIsConnecting(false);
    }
  };

  const handleSave = async () => {
    setIsConnecting(true);
    setLocalError(null);
    try {
      const config = await buildConnectionConfig(true);
      if (!config) return;
      scope.assertCurrent('save workspace connection');
      await sshApi.saveConnection(config);
      scope.assertCurrent('finish saving workspace connection');
      onClose();
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : t('workspaceSource.connectionFailed'));
    } finally { setIsConnecting(false); }
  };

  const handleTestConnection = async () => {
    setIsTesting(true);
    setConnectionTest(null);
    setLocalError(null);
    try {
      const config = await buildConnectionConfig(true);
      if (!config) return;
      setConnectionTest(await sshApi.testConnection(config));
    } catch (_error) {
      setLocalError(t('ssh.remote.testFailed'));
    } finally {
      setIsTesting(false);
    }
  };

  const handleListContainers = async () => {
    const requestId = ++containerRequestId.current;
    setIsListingContainers(true);
    setLocalError(null);
    try {
      const config = await buildConnectionConfig(false);
      if (!config || requestId !== containerRequestId.current || !scope.isCurrent()) return;
      const containers = await sshApi.listDockerContainers(config);
      if (requestId !== containerRequestId.current || !scope.isCurrent()) return;
      setDockerContainers(containers);
      if (containers.length === 0) {
        setLocalError(t('ssh.remote.noContainersFound'));
      }
    } catch (error) {
      if (requestId === containerRequestId.current && scope.isCurrent()) setLocalError(t(workspaceSourceErrorKey(formData.targetType, error)));
    } finally {
      if (requestId === containerRequestId.current && scope.isCurrent()) setIsListingContainers(false);
    }
  };

  useEffect(() => {
    if (!open || !inheritedHost || !containerHost) return;
    let cancelled = false;
    setDockerContainers([]); setLocalError(null); setIsListingContainers(true);
    void sshApi.listDockerContainers({ ...savedConnectionConfig(containerHost), id: initialPreset?.credentialConnectionId || containerHost.id, container: {
      name: 'discovery', local: false, access: 'auto', dockerPath: 'docker', shell: '/bin/sh', interactive: true,
    } }).then(containers => {
      if (!cancelled && scope.isCurrent()) setDockerContainers(containers);
    }).catch(cause => {
      if (!cancelled && scope.isCurrent()) setLocalError(t(workspaceSourceErrorKey('remoteDocker', cause)));
    }).finally(() => { if (!cancelled && scope.isCurrent()) setIsListingContainers(false); });
    return () => { cancelled = true; };
  }, [open, inheritedHost, containerHost, scope, t, initialPreset?.credentialConnectionId]);

  const handleSavedConnectionFailure = useCallback((conn: SavedConnection, error: unknown) => {
    // Native targets have no SSH authentication to repair. Show an
    // environment-specific status instead of asking for SSH credentials.
    if (conn.wsl || conn.container?.local) {
      setLocalError(t(workspaceSourceErrorKey(savedConnectionTarget(conn), error)));
    } else if (isSshAuthenticationError(error)) setCredentialsPrompt(conn);
    else setLocalError(t('workspaceSource.connectionFailed'));
  }, [t]);

  const handleQuickConnect = useCallback(async (conn: SavedConnection) => {
    setLocalError(null);
    if (conn.authType.type === 'KeyboardInteractive') { setCredentialsPrompt(conn); return; }
    setIsConnecting(true);
    try { await connectAndFinish(savedConnectionConfig(conn)); }
    catch (cause) { handleSavedConnectionFailure(conn, cause); }
    finally { setIsConnecting(false); }
  }, [connectAndFinish, handleSavedConnectionFailure]);

  // Fill the manual connection form from an ~/.ssh/config host entry
  const handleFillFromConfig = useCallback((configHost: SSHConfigEntry) => {
    const port = configHost.port ? String(configHost.port) : '22';
    const username = configHost.user || '';
    const keyPath = configHost.identityFile?.trim() || '~/.ssh/id_rsa';
    const hasKey = !!configHost.identityFile?.trim();

    setFormData(prev => ({
      ...prev,
      name: configHost.host,
      host: configHost.host,
      port,
      username,
      authType: hasKey ? 'privateKey' : configHost.agent ? 'agent' : 'password',
      password: '',
      keyPath,
      passphrase: '',
      certificatePath: configHost.certificateFile || '',
      keyFingerprint: '',
      fallbackKeyPath: '~/.ssh/id_rsa',
      verificationCode: '',
      proxyJump: configHost.proxyJump || '',
      connectTimeoutSecs: '30',
      authTimeoutSecs: '60',
      authAttempts: '3',
      connectAttempts: '1',
    }));
    setShowAdvancedSettings(Boolean(configHost.proxyJump || configHost.certificateFile));
    // Config list sits above the form; scroll so the filled fields are visible.
    requestAnimationFrame(() => scrollToConnectionForm());
  }, [scrollToConnectionForm]);

  const handleCredentialsPromptSubmit = async (payload: SSHAuthPromptSubmitPayload) => {
    if (!credentialsPrompt) return;

    const { auth, username: resolvedUsername } = payload;
    const conn = credentialsPrompt;
    setIsConnecting(true);
    setLocalError(null);
    try {
      const full: SSHConnectionConfig = {
        id: conn.id,
        name: conn.name,
        host: conn.host,
        port: conn.port,
        username: resolvedUsername,
        auth,
        defaultWorkspace: conn.defaultWorkspace,
        proxyJump: conn.proxyJump,
        container: conn.container,
        wsl: conn.wsl,
        options: conn.options,
      };
      await connectAndFinish(full);
      setCredentialsPrompt(null);
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : 'Connection failed');
    } finally {
      setIsConnecting(false);
    }
  };

  const handleCredentialsPromptCancel = () => {
    setCredentialsPrompt(null);
    setLocalError(null);
    if (initialPreset?.kind === 'saved' && !editOnly) onClose();
  };

  const handleEditConnection = useCallback((e: React.MouseEvent | null, conn: SavedConnection) => {
    e?.stopPropagation();
    setEditingProfile(conn);
    if (savedConnectionTarget(conn) === 'remoteDocker') setContainerHost({ ...conn, container: undefined });
    setConnectionView('new');
    endpointDrafts.current = {};
    const keyPath = conn.authType.type === 'PrivateKey' ? conn.authType.keyPath : '~/.ssh/id_rsa';
    const defaultConnectionName = conn.wsl
      ? `WSL · ${conn.wsl.distribution}${conn.wsl.user ? ` · ${conn.wsl.user}` : ''}`
      : conn.container?.local
        ? conn.container.name
        : `${conn.username}@${conn.host}`;
    const authType = conn.authType.type === 'Password'
      ? 'password'
      : conn.authType.type === 'PrivateKey'
        ? 'privateKey'
        : conn.authType.type === 'Agent'
          ? 'agent'
          : 'keyboardInteractive';
    const targetType = savedConnectionTarget(conn);
    setFormData({
      targetType,
      name: conn.name,
      host: conn.host,
      port: String(conn.port),
      username: conn.username,
      authType,
      password: '',
      keyPath,
      passphrase: '',
      certificatePath: conn.authType.type === 'PrivateKey'
        ? conn.authType.certificatePath || ''
        : '',
      keyFingerprint: conn.authType.type === 'Agent'
        ? conn.authType.keyFingerprint || ''
        : '',
      fallbackKeyPath: conn.authType.type === 'Agent'
        ? conn.authType.fallbackKeyPath || ''
        : '~/.ssh/id_rsa',
      verificationCode: '',
      proxyJump: conn.proxyJump || '',
      wslDistribution: conn.wsl?.distribution || '',
      wslUser: conn.wsl?.user || '',
      containerName: conn.container?.name || '',
      containerAccess: conn.container?.access === 'docker-exec' ? 'docker-exec' : 'auto',
      dockerPath: conn.container?.dockerPath || 'docker',
      containerShell: conn.container?.shell || '/bin/sh',
      containerUser: conn.container?.user || '',
      connectTimeoutSecs: String(conn.options?.connectTimeoutSecs ?? 30),
      authTimeoutSecs: String(conn.options?.authTimeoutSecs ?? 60),
      authAttempts: String(conn.options?.authAttempts ?? 3),
      connectAttempts: String(conn.options?.connectAttempts ?? 1),
    });
    setShowAdvancedSettings(
      Boolean(conn.proxyJump || conn.wsl?.user)
      || (conn.authType.type === 'PrivateKey' && Boolean(conn.authType.certificatePath))
      || (conn.authType.type === 'Agent' && Boolean(conn.authType.keyFingerprint || conn.authType.fallbackKeyPath))
      || Boolean(conn.container && conn.container.access !== 'sshd' && (
        conn.container.access === 'docker-exec' || conn.container.dockerPath !== 'docker'
        || conn.container.shell !== '/bin/sh' || conn.container.user
      ))
      || conn.name !== defaultConnectionName
      || (conn.options?.connectTimeoutSecs ?? 30) !== 30
      || (conn.options?.authTimeoutSecs ?? 60) !== 60
      || (conn.options?.authAttempts ?? 3) !== 3
      || (conn.options?.connectAttempts ?? 1) !== 1
    );
    requestAnimationFrame(() => scrollToConnectionForm());
  }, [scrollToConnectionForm]);

  const handleDeleteConnection = async (e: React.MouseEvent, connectionId: string) => {
    e.stopPropagation();
    try {
      await sshApi.deleteConnection(connectionId);
      await loadSavedConnections();
      return true;
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to delete');
      return false;
    }
  };

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
  const containerAccessOptions = [
    { label: t('ssh.remote.containerAccessAuto'), value: 'auto' },
    { label: t('ssh.remote.containerAccessDockerExec'), value: 'docker-exec' },
  ];
  const formatTestStageLabel = (stage: ConnectionTestStage): string => {
    if (stage.id.startsWith('jump-')) {
      return `${t('ssh.remote.testStageJump')} ${stage.id.slice('jump-'.length)} · ${stage.label}`;
    }
    if (stage.id === 'target') {
      return `${t('ssh.remote.testStageTarget')} · ${stage.label}`;
    }
    if (stage.id === 'container') {
      return `${t('ssh.remote.testStageContainer')} · ${stage.label}`;
    }
    if (stage.id === 'wsl') return `WSL · ${stage.label}`;
    if (stage.id === 'docker-host') {
      return t('ssh.remote.testStageLocalDocker');
    }
    return `${t('ssh.remote.testStageConfiguration')} · ${stage.label}`;
  };
  const usesDockerTarget = formData.targetType === 'localDocker' || formData.targetType === 'remoteDocker';
  const isRemoteContainer = formData.targetType === 'remoteDocker' || formData.targetType === 'containerSshd';
  const sourceBusy = isConnecting || status === 'connecting' || isTesting;
  const wslUnavailable = isListingWsl
    || !wslDistributions?.supported
    || !wslDistributions.distributions.includes(formData.wslDistribution);

  const availableSavedConnections = savedConnections.filter(conn =>
    sameWorkspaceSource(savedConnectionTarget(conn), fixedSource ? initialTargetType : formData.targetType));
  const selectedConnection = availableSavedConnections.find(connection => connection.id === selectedConnectionId);
  useEffect(() => {
    setSelectedConnectionId(current => savedConnections.some(connection => connection.id === current
      && sameWorkspaceSource(savedConnectionTarget(connection), fixedSource ? initialTargetType : formData.targetType)) ? current : undefined);
  }, [savedConnections, fixedSource, initialTargetType, formData.targetType]);
  useEffect(() => {
    if (!open) { appliedPreset.current = undefined; return; }
    if (!initialPreset || appliedPreset.current === initialPreset) return;
    appliedPreset.current = initialPreset;
    if (initialPreset.kind === 'saved') {
      if (sameWorkspaceSource(savedConnectionTarget(initialPreset.connection), initialTargetType)) {
        if (editOnly) handleEditConnection(null, initialPreset.connection);
        else if (initialPreset.authenticate) setCredentialsPrompt(initialPreset.connection);
        else void handleQuickConnect(initialPreset.connection);
      }
    } else if (initialPreset.kind === 'sshConfig') {
      setConnectionView('new');
      handleFillFromConfig(initialPreset.entry);
    } else {
      setConnectionView('new');
      if (initialPreset.host && initialTargetType === 'remoteDocker') {
        handleEditConnection(null, { ...initialPreset.host, name: '', container: {
          name: '', local: false, access: 'auto', dockerPath: 'docker', shell: '/bin/sh', interactive: true,
        } });
        setEditingProfile(undefined);
        setContainerHost(initialPreset.host);
        setShowAdvancedSettings(false);
      }
    }
  }, [open, initialPreset, initialTargetType, editOnly, handleEditConnection, handleFillFromConfig, handleQuickConnect]);
  const showNewConnection = editOnly || initialPreset?.kind === 'new' || initialPreset?.kind === 'sshConfig' || availableSavedConnections.length === 0 || connectionView === 'new';
  const showSshConfig = !isLocalProcessTarget && !inheritedHost && !initialPreset;
  const filteredSavedConnections = availableSavedConnections.filter((conn) => {
    if (!savedSearch.trim()) return true;
    const q = savedSearch.toLowerCase();
    return (
      conn.name.toLowerCase().includes(q) ||
      conn.host.toLowerCase().includes(q) ||
      conn.username.toLowerCase().includes(q)
    );
  });

  const filteredSSHConfigHosts = sshConfigHosts.filter((configHost) => {
    // Hide SSH config hosts that already have a saved connection
    const hostname = configHost.hostname || configHost.host;
    const port = configHost.port || 22;
    const user = configHost.user || '';
    if (availableSavedConnections.some((c) => !c.container && !c.wsl && c.host === hostname && c.port === port && c.username === user)) {
      return false;
    }
    if (!configSearch.trim()) return true;
    const q = configSearch.toLowerCase();
    return (
      configHost.host.toLowerCase().includes(q) ||
      hostname.toLowerCase().includes(q) ||
      (configHost.user || '').toLowerCase().includes(q)
    );
  });

  const dismissError = () => {
    setLocalError(null);
    clearError();
  };

  return (
    <>
      <Dialog
        open={open && !(initialPreset?.kind === 'saved' && !editOnly && credentialsPrompt)}
        onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}
        size="lg"
        className="ssh-connection-dialog__surface"
        closeOnPointerOutside={false}
      >
        <DialogHeader>
          <DialogHeading>
            <DialogTitle>{connectionTitle}</DialogTitle>
          </DialogHeading>
          <DialogClose />
        </DialogHeader>
        <DialogBody inset="none">
        <div className="ssh-connection-dialog" data-openbitfun-component="ssh-remote" data-openbitfun-part="connection">
          {error && (
            <div className="ssh-connection-dialog__error-banner" data-openbitfun-component="ssh-remote" data-openbitfun-part="connectionError">
              <div className="ssh-connection-dialog__source-status" role="alert">{error}</div>
              <IconButton size="xs" variant="quiet" icon={<Icon name="xmark" size="xs" />} aria-label={t('actions.close')} onClick={dismissError} />
            </div>
          )}

          <ScrollArea scrollbarVisibility="hidden" className="ssh-connection-dialog__scroll" data-openbitfun-component="ssh-remote" data-openbitfun-part="connectionContent">
          {!fixedSource && <div className="ssh-connection-dialog__source">
            <WorkspaceSourceSelector value={formData.targetType}
              allowHostDirectory={false} disabled={sourceBusy}
              onValueChange={source => { if (source !== 'host') handleTargetChange(source); }} />
          </div>}
          {availableSavedConnections.length > 0 && !initialPreset && (
            <div className="ssh-connection-dialog__source">
              <TabGroup aria-label={t('workspaceSource.connectionChoice')} value={connectionView}
                onValueChange={value => setConnectionView(value as 'saved' | 'new')}
                items={[
                  { value: 'saved', label: t('workspaceSource.useSavedConnection'), disabled: sourceBusy,
                    id: `${connectionViewId}-saved-tab`, panelId: `${connectionViewId}-saved-panel` },
                  { value: 'new', label: t('ssh.remote.newConnection'), disabled: sourceBusy,
                    id: `${connectionViewId}-new-tab`, panelId: `${connectionViewId}-new-panel` },
                ]} />
            </div>
          )}
          {/* Saved connections section */}
          {!showNewConnection && (
            <div role="tabpanel" id={`${connectionViewId}-saved-panel`} aria-labelledby={`${connectionViewId}-saved-tab`}>
            <FormSection
              className="ssh-connection-dialog__section"
              data-openbitfun-component="ssh-remote"
              data-openbitfun-part="connectionSection"
              headingAs="h3"
              title={<span className="ssh-connection-dialog__section-title">{t('ssh.remote.savedConnections')}</span>}
              actions={(
                <div className="ssh-connection-dialog__section-actions">
                <SearchField
                  className="ssh-connection-dialog__search"
                  value={savedSearch}
                  onValueChange={setSavedSearch}
                  placeholder={t('actions.search')}
                  aria-label={`${t('actions.search')} · ${t('ssh.remote.savedConnections')}`}
                  leadingIcon={<Icon name="search" size="sm" />}
                  clearLabel={t('actions.clear')}
                  onClear={savedSearch ? () => setSavedSearch('') : undefined}
                  size="sm"
                />
                </div>
              )}
            >
              <ScrollArea scrollbarVisibility="hidden" className="ssh-connection-dialog__saved-list" data-openbitfun-component="ssh-remote" data-openbitfun-part="connectionList">
                <WorkspaceChoiceCapsules label={t('ssh.remote.savedConnections')} value={selectedConnectionId}
                  disabled={sourceBusy} onValueChange={setSelectedConnectionId}
                  onEdit={id => {
                    const connection = availableSavedConnections.find(item => item.id === id);
                    if (connection) setEditingPreset({ kind: 'saved', connection, edit: true });
                  }}
                  choices={filteredSavedConnections.map(conn => ({
                    id: conn.id, label: conn.name,
                    description: conn.wsl
                      ? `WSL · ${conn.wsl.distribution}${conn.wsl.user ? ` · ${conn.wsl.user}` : ''}`
                      : conn.container?.local
                        ? `Docker · ${conn.container.name}`
                        : `${conn.username}@${conn.host}:${conn.port}${conn.container ? ` · ${conn.container.name}` : ''}${conn.proxyJump ? ` · ${t('ssh.remote.via')} ${conn.proxyJump}` : ''}`,
                  }))} />
              </ScrollArea>
            </FormSection>
            </div>
          )}

          {showNewConnection && (
          <div role={availableSavedConnections.length > 0 && !initialPreset ? 'tabpanel' : undefined}
            id={`${connectionViewId}-new-panel`}
            aria-labelledby={availableSavedConnections.length > 0 && !initialPreset ? `${connectionViewId}-new-tab` : undefined}>
          {/* SSH Config hosts section */}
          {showSshConfig && sshConfigHosts.length > 0 && (
            <FormSection
              className="ssh-connection-dialog__section"
              headingAs="h3"
              title={<span className="ssh-connection-dialog__section-title">{t('ssh.remote.sshConfigHosts') || 'SSH Config'}</span>}
              actions={(
                <SearchField
                  className="ssh-connection-dialog__search"
                  value={configSearch}
                  onValueChange={setConfigSearch}
                  placeholder={t('actions.search')}
                  aria-label={`${t('actions.search')} · ${t('ssh.remote.sshConfigHosts')}`}
                  leadingIcon={<Icon name="search" size="sm" />}
                  clearLabel={t('actions.clear')}
                  onClear={configSearch ? () => setConfigSearch('') : undefined}
                  size="sm"
                />
              )}
            >
              <ScrollArea scrollbarVisibility="hidden" className="ssh-connection-dialog__saved-list">
                {filteredSSHConfigHosts.map((configHost) => (
                  <div
                    key={configHost.host}
                    data-openbitfun-component="ssh-remote"
                    data-openbitfun-part="connectionItem"
                  >
                    <Capsule size="xs"><Button variant="fill" size="xs"
                      onClick={() => handleFillFromConfig(configHost)}
                      disabled={isConnecting || status === 'connecting'}
                      title={`${configHost.user || ''}@${configHost.hostname || configHost.host}:${configHost.port || 22}`}
                      aria-label={t('ssh.remote.fillForm')}
                    >{configHost.host}</Button></Capsule>
                  </div>
                ))}
              </ScrollArea>
            </FormSection>
          )}

          {/* Divider */}
          {showSshConfig && sshConfigHosts.length > 0 && (
            <div className="ssh-connection-dialog__divider">
              <span>{t('ssh.remote.newConnection')}</span>
            </div>
          )}

          {/* New connection form */}
          <FieldGroup
            ref={formRef}
            appearance="plain"
            dividers={false}
            className="ssh-connection-dialog__form"
            data-openbitfun-component="ssh-remote"
            data-openbitfun-part="connectionForm"
          >
            {isRemoteContainer && !fixedSource && !editOnly && (
              <Field label={t('workspaceSource.containerConnection')} controlWidth="fill">
                <Select size="md" value={formData.targetType} disabled={sourceBusy}
                  options={[
                    { value: 'remoteDocker', label: t('workspaceSource.viaHost') },
                    { value: 'containerSshd', label: t('workspaceSource.directContainer') },
                  ]}
                  onValueChange={value => handleTargetChange(value as WorkspaceConnectionTarget)} />
              </Field>
            )}

            {isWslTarget && (
              <>
                <FormSection title={t('ssh.remote.wslDistribution')} headingAs="h3"
                  actions={(
                    <Tooltip content={t('ssh.remote.wslRefresh')}><IconButton variant="quiet" size="xs"
                      icon={<Icon name="refresh" size="xs" />} aria-label={t('ssh.remote.wslRefresh')}
                      loading={isListingWsl} onClick={() => setWslRefresh((value) => value + 1)} disabled={sourceBusy} /></Tooltip>
                  )}>
                  <WorkspaceChoiceCapsules label={t('ssh.remote.wslDistribution')}
                    choices={(wslDistributions?.distributions ?? []).map(distribution => ({ id: distribution, label: distribution }))}
                    value={formData.wslDistribution}
                    onValueChange={value => handleInputChange('wslDistribution', value || '')}
                    disabled={isListingWsl || !wslDistributions?.supported}
                  />
                </FormSection>

                {(wslError || wslDistributions?.supported === false || wslDistributions?.distributions.length === 0) && <div className="ssh-connection-dialog__hint" role={wslError ? 'alert' : 'status'}>
                  {wslError || (wslDistributions?.supported === false
                    ? t('ssh.remote.wslUnsupported')
                    : wslDistributions?.distributions.length === 0
                      ? t('ssh.remote.wslNoDistributions')
                      : '')}
                </div>}
              </>
            )}

            {inheritedHost && !hostIsFixed && (
              <FormSection title={t('workspaceSource.sshHost')} headingAs="h3">
                <WorkspaceChoiceCapsules label={t('workspaceSource.sshHost')} value={containerHost?.id}
                  choices={(containerHost && !savedConnections.some(conn => conn.id === containerHost.id)
                    ? [containerHost, ...savedConnections.filter(conn => !conn.container && !conn.wsl)]
                    : savedConnections.filter(conn => !conn.container && !conn.wsl)).map(conn => ({ id: conn.id, label: conn.name, description: `${conn.username}@${conn.host}:${conn.port}` }))}
                  disabled={sourceBusy} onValueChange={id => {
                    const host = id === containerHost?.id ? containerHost : savedConnections.find(conn => conn.id === id);
                    setContainerHost(host); setFormData(prev => ({ ...prev, containerName: '' })); setDockerContainers([]); setLocalError(null); setConnectionTest(null);
                  }} />
                {!containerHost && <div className="ssh-connection-dialog__source-status" role="status">{t('workspaceSource.existingHostRequired')}</div>}
              </FormSection>
            )}
            {!isLocalProcessTarget && !inheritedHost && (
              <>
            {/* Host and Port */}
            <FieldRow padding="none" className="ssh-connection-dialog__row ssh-connection-dialog__row--host">
              <div className="ssh-connection-dialog__field ssh-connection-dialog__field--flex">
                <Field label={t(isRemoteContainer
                  ? formData.targetType === 'containerSshd' ? 'workspaceSource.containerAddress' : 'workspaceSource.dockerHostAddress'
                  : 'ssh.remote.host')} controlWidth="fill">
                  <DesignInput
                    size="md"
                    value={formData.host}
                    onChange={(e) => handleInputChange('host', e.target.value)}
                    placeholder=""
                    leading={<Server size={16} />}
                  />
                </Field>
              </div>
              <div className="ssh-connection-dialog__field ssh-connection-dialog__field--port">
                <Field label={t('ssh.remote.port')} controlWidth="fill">
                  <DesignInput
                    size="md"
                    value={formData.port}
                    inputMode="numeric"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => handleInputChange('port', e.target.value)}
                    placeholder="22"
                  />
                </Field>
              </div>
            </FieldRow>

            {/* Username */}
            <FieldRow padding="none" className="ssh-connection-dialog__field">
              <Field label={t('ssh.remote.username')} controlWidth="fill">
                <DesignInput
                  size="md"
                  value={formData.username}
                  onChange={(e) => handleInputChange('username', e.target.value)}
                  placeholder=""
                  leading={<Icon name="user" size="md" />}
                />
              </Field>
            </FieldRow>
              </>
            )}

            {!isLocalProcessTarget && !inheritedHost && (
              <>
            {/* Authentication Method */}
            <FieldRow padding="none" className="ssh-connection-dialog__field">
              <Field label={t('ssh.remote.authMethod')} controlWidth="fill">
                <Select
                  options={authOptions}
                  value={formData.authType}
                  onValueChange={(value) => handleInputChange('authType', String(value))}
                  size="md"
                />
              </Field>
            </FieldRow>

            {/* Password */}
            {formData.authType === 'password' && (
              <FieldRow padding="none" className="ssh-connection-dialog__field">
                <Field label={t('ssh.remote.password')} controlWidth="fill">
                  <DesignInput
                    size="md"
                    hideNativePasswordReveal
                    type={showPassword ? 'text' : 'password'}
                    value={formData.password}
                    onChange={(e) => handleInputChange('password', e.target.value)}
                    placeholder=""
                    leading={<Lock size={16} />}
                    trailing={
                      <IconButton
                        type="button"
                        size="sm"
                        variant="quiet"
                        aria-label={showPassword ? t('ssh.remote.hidePassword') : t('ssh.remote.showPassword')}
                        onClick={() => setShowPassword(s => !s)}
                        icon={showPassword ? <EyeOff size={16} /> : <Icon name="eye" size="md" />}
                      />
                    }
                  />
                </Field>
              </FieldRow>
            )}

            {/* Private Key */}
            {formData.authType === 'privateKey' && (
              <>
                <FieldRow padding="none" className="ssh-connection-dialog__field">
                  <Field label={t('ssh.remote.privateKeyPath')} controlWidth="fill">
                    <DesignInput
                      size="md"
                      value={formData.keyPath}
                      onChange={(e) => handleInputChange('keyPath', e.target.value)}
                      placeholder="~/.ssh/id_rsa"
                      leading={<Key size={16} />}
                      trailing={
                        <Tooltip content={t('ssh.remote.browsePrivateKey')}>
                          <IconButton
                            type="button"
                            size="sm"
                            className="ssh-connection-dialog__browse-key"
                            aria-label={t('ssh.remote.browsePrivateKey')}
                            disabled={isConnecting || status === 'connecting'}
                            onClick={() => void handleBrowsePrivateKey()}
                            icon={<FolderOpen size={16} />}
                          />
                        </Tooltip>
                      }
                    />
                  </Field>
                </FieldRow>
                <FieldRow padding="none" className="ssh-connection-dialog__field">
                  <Field label={t('ssh.remote.passphrase')} controlWidth="fill">
                    <DesignInput
                      size="md"
                      hideNativePasswordReveal
                      type={showPassphrase ? 'text' : 'password'}
                      value={formData.passphrase}
                      onChange={(e) => handleInputChange('passphrase', e.target.value)}
                      placeholder={t('ssh.remote.passphraseOptional')}
                      trailing={
                        <IconButton
                          type="button"
                          size="sm"
                          variant="quiet"
                          aria-label={showPassphrase ? t('ssh.remote.hidePassword') : t('ssh.remote.showPassword')}
                          onClick={() => setShowPassphrase(s => !s)}
                          icon={showPassphrase ? <EyeOff size={16} /> : <Icon name="eye" size="md" />}
                        />
                      }
                    />
                  </Field>
                </FieldRow>

              </>
            )}

            {formData.authType === 'keyboardInteractive' && (
              <FieldRow padding="none" className="ssh-connection-dialog__row">
                <div className="ssh-connection-dialog__field ssh-connection-dialog__field--flex">
                  <Field label={t('ssh.remote.challengePassword')} controlWidth="fill">
                    <DesignInput
                      size="md"
                      type="password"
                      value={formData.password}
                      onChange={(e) => handleInputChange('password', e.target.value)}
                    />
                  </Field>
                </div>
                <div className="ssh-connection-dialog__field ssh-connection-dialog__field--flex">
                  <Field label={t('ssh.remote.verificationCode')} controlWidth="fill">
                    <DesignInput
                      size="md"
                      type="password"
                      value={formData.verificationCode}
                      onChange={(e) => handleInputChange('verificationCode', e.target.value)}
                      placeholder={t('ssh.remote.optional')}
                    />
                  </Field>
                </div>
              </FieldRow>
            )}

              </>
            )}

            {usesDockerTarget && (
              <div className="ssh-connection-dialog__container-fields">
                <Field label={t('ssh.remote.containerName')} controlWidth="fill"
                  className="ssh-connection-dialog__field"
                  labelAction={(
                    <Tooltip content={t('ssh.remote.discoverContainers')}><IconButton variant="quiet" size="xs" onClick={() => void handleListContainers()}
                      icon={<Icon name="refresh" size="xs" />} aria-label={t('ssh.remote.discoverContainers')} loading={isListingContainers}
                      disabled={isListingContainers || isConnecting || status === 'connecting'} /></Tooltip>
                  )}>
                  <Combobox
                    options={dockerContainers.map(container => ({
                      label: container.name, description: `${container.image} · ${container.state}`, value: container.name,
                    }))}
                    value={formData.containerName}
                    onValueChange={value => handleInputChange('containerName', String(value))}
                    onCreateValue={value => value.trim()}
                    placeholder={t('ssh.remote.containerNamePlaceholder')}
                    loading={isListingContainers} clearable size="md" />
                </Field>
              </div>
            )}

            <Disclosure className="ssh-connection-dialog__advanced"
              contentInnerClassName="ssh-connection-dialog__advanced-content"
              summary={t('ssh.remote.advancedSettings')} open={showAdvancedSettings}
              onOpenChange={setShowAdvancedSettings} disabled={sourceBusy} unmountOnClose>
                <div className="ssh-connection-dialog__advanced-fields">
                  <div className="ssh-connection-dialog__field">
                    <Field label={t('ssh.remote.connectionName')} controlWidth="fill">
                      <DesignInput
                        size="md"
                        value={formData.name}
                        onChange={(e) => handleInputChange('name', e.target.value)}
                        placeholder={t('ssh.remote.connectionNamePlaceholder')}
                      />
                    </Field>
                  </div>

                  {isWslTarget && (
                    <Field label={t('ssh.remote.wslUser')} controlWidth="fill">
                      <DesignInput
                        size="md"
                        value={formData.wslUser}
                        onChange={(event) => handleInputChange('wslUser', event.target.value)}
                        placeholder={t('ssh.remote.wslDefaultUser')}
                      />
                    </Field>
                  )}
                  {usesDockerTarget && (
                    <FormSection title={t('workspaceSource.containerOptions')} headingAs="h3">
                      <div className="ssh-connection-dialog__field">
                        <Field label={t('ssh.remote.containerAccess')} controlWidth="fill">
                          <Select
                            options={containerAccessOptions}
                            value={formData.containerAccess}
                            onValueChange={(value) => handleInputChange('containerAccess', String(value))}
                            size="md"
                          />
                        </Field>
                      </div>
                      <div className="ssh-connection-dialog__field">
                        <Field label={t('ssh.remote.dockerPath')} controlWidth="fill">
                          <DesignInput
                            size="md"
                            value={formData.dockerPath}
                            onChange={(e) => handleInputChange('dockerPath', e.target.value)}
                            placeholder="docker"
                          />
                        </Field>
                      </div>
                      <div className="ssh-connection-dialog__row">
                        <div className="ssh-connection-dialog__field ssh-connection-dialog__field--flex">
                          <Field label={t('ssh.remote.containerShell')} controlWidth="fill">
                            <DesignInput
                              size="md"
                              value={formData.containerShell}
                              onChange={(e) => handleInputChange('containerShell', e.target.value)}
                              placeholder="/bin/sh"
                            />
                          </Field>
                        </div>
                        <div className="ssh-connection-dialog__field ssh-connection-dialog__field--flex">
                          <Field label={t('ssh.remote.containerUser')} controlWidth="fill">
                            <DesignInput
                              size="md"
                              value={formData.containerUser}
                              onChange={(e) => handleInputChange('containerUser', e.target.value)}
                              placeholder={t('ssh.remote.optional')}
                            />
                          </Field>
                        </div>
                      </div>
                    </FormSection>
                  )}
                  {!isLocalProcessTarget && !inheritedHost && formData.authType === 'privateKey' && (
                    <FieldRow padding="none" className="ssh-connection-dialog__field">
                      <Field label={t('ssh.remote.certificatePath')} controlWidth="fill">
                        <DesignInput
                          size="md"
                          value={formData.certificatePath}
                          onChange={(e) => handleInputChange('certificatePath', e.target.value)}
                          placeholder={t('ssh.remote.certificatePathOptional')}
                          trailing={
                            <Tooltip content={t('ssh.remote.browseCertificate')}>
                              <IconButton
                                type="button"
                                size="sm"
                                className="ssh-connection-dialog__browse-key"
                                aria-label={t('ssh.remote.browseCertificate')}
                                disabled={isConnecting || status === 'connecting'}
                                onClick={() => void handleBrowseCertificate()}
                                icon={<FolderOpen size={16} />}
                              />
                            </Tooltip>
                          }
                        />
                      </Field>
                    </FieldRow>
                  )}
                  {!isLocalProcessTarget && !inheritedHost && formData.authType === 'agent' && (
                    <>
                      <FieldRow padding="none" className="ssh-connection-dialog__field">
                        <Field label={t('ssh.remote.agentFingerprint')} controlWidth="fill">
                          <DesignInput
                            size="md"
                            value={formData.keyFingerprint}
                            onChange={(e) => handleInputChange('keyFingerprint', e.target.value)}
                            placeholder={t('ssh.remote.optional')}
                          />
                        </Field>
                      </FieldRow>
                      <FieldRow padding="none" className="ssh-connection-dialog__field">
                        <Field label={t('ssh.remote.agentFallbackKey')} controlWidth="fill">
                          <DesignInput
                            size="md"
                            value={formData.fallbackKeyPath}
                            onChange={(e) => handleInputChange('fallbackKeyPath', e.target.value)}
                            placeholder={t('ssh.remote.optional')}
                          />
                        </Field>
                      </FieldRow>
                    </>
                  )}

                  {!isLocalProcessTarget && !inheritedHost && (
                    <>
                      <div className="ssh-connection-dialog__field">
                        <Field label={t('ssh.remote.proxyJump')} controlWidth="fill">
                          <DesignInput
                            size="md"
                            value={formData.proxyJump}
                            onChange={(e) => handleInputChange('proxyJump', e.target.value)}
                            placeholder={t('ssh.remote.proxyJumpPlaceholder')}
                          />
                        </Field>
                        <div className="ssh-connection-dialog__hint">
                          {t('ssh.remote.proxyJumpHint')}
                        </div>
                        {/*
                          A hop without its own IdentityFile falls back to this
                          connection's credentials, so the bastion sees the
                          target's password. Worth saying out loud before it is
                          sent, not after.
                        */}
                        {formData.proxyJump.trim() && formData.authType === 'password' && (
                          <div className="ssh-connection-dialog__hint ssh-connection-dialog__hint--warning">
                            {t('ssh.remote.proxyJumpPasswordWarning')}
                          </div>
                        )}
                      </div>

                      <FormSection title={t('ssh.remote.connectionOptions')} headingAs="h3">
                        <div className="ssh-connection-dialog__options-grid">
                          <div className="ssh-connection-dialog__field">
                            <Field label={t('ssh.remote.connectTimeout')} controlWidth="fill">
                              <NumberInput
                                size="md"
                                min={1} precision={0} disableWheel showButtons={false}
                                value={Number(formData.connectTimeoutSecs)}
                                onValueChange={value => handleInputChange('connectTimeoutSecs', String(value))}
                              />
                            </Field>
                          </div>
                          <div className="ssh-connection-dialog__field">
                            <Field label={t('ssh.remote.authTimeout')} controlWidth="fill">
                              <NumberInput
                                size="md"
                                min={1} precision={0} disableWheel showButtons={false}
                                value={Number(formData.authTimeoutSecs)}
                                onValueChange={value => handleInputChange('authTimeoutSecs', String(value))}
                              />
                            </Field>
                          </div>
                          <div className="ssh-connection-dialog__field">
                            <Field label={t('ssh.remote.authAttempts')} controlWidth="fill">
                              <NumberInput
                                size="md"
                                min={1} max={10} precision={0} disableWheel showButtons={false}
                                value={Number(formData.authAttempts)}
                                onValueChange={value => handleInputChange('authAttempts', String(value))}
                              />
                            </Field>
                          </div>
                          <div className="ssh-connection-dialog__field">
                            <Field label={t('ssh.remote.connectAttempts')} controlWidth="fill">
                              <NumberInput
                                size="md"
                                min={1} max={5} precision={0} disableWheel showButtons={false}
                                value={Number(formData.connectAttempts)}
                                onValueChange={value => handleInputChange('connectAttempts', String(value))}
                              />
                            </Field>
                          </div>
                        </div>
                      </FormSection>
                    </>
                  )}
                </div>
            </Disclosure>

            {connectionTest && (
              <div
                className={[
                  'ssh-connection-dialog__test-report',
                  connectionTest.success
                    ? 'ssh-connection-dialog__test-report--success'
                    : 'ssh-connection-dialog__test-report--error',
                ].join(' ')}
              >
                {connectionTest.stages.map((stage) => (
                  <div key={stage.id} className="ssh-connection-dialog__test-stage">
                    {stage.success
                      ? <Icon name="check-circle" size="sm" />
                      : <Icon name="xmark" size="sm" />}
                    <OverflowText>{formatTestStageLabel(stage)}</OverflowText>
                    {stage.error && <OverflowText title={stage.error}>{stage.error}</OverflowText>}
                  </div>
                ))}
                {connectionTest.resolvedContainerAccess && (
                  <div className="ssh-connection-dialog__hint">
                    {t('ssh.remote.resolvedContainerAccess')}:{' '}
                    {connectionTest.resolvedContainerAccess === 'sshd'
                      ? t('ssh.remote.containerAccessSshd')
                      : connectionTest.resolvedContainerAccess === 'docker-exec'
                        ? t('ssh.remote.containerAccessDockerExec')
                        : t('ssh.remote.containerAccessAuto')}
                  </div>
                )}
              </div>
            )}
          </FieldGroup>
          </div>
          )}
          </ScrollArea>

        </div>
        </DialogBody>

        <DialogFooter
          separator
          className="ssh-connection-dialog__actions"
          data-openbitfun-component="ssh-remote"
          data-openbitfun-part="connectionActions"
        >
            {showNewConnection && <Button
              variant="outline"
              size="sm"
              onClick={() => void handleTestConnection()}
              disabled={isTesting || isConnecting || status === 'connecting' || (isWslTarget && wslUnavailable)}
            >
              {isTesting && <Loader2 size={14} className="ssh-connection-dialog__spinner" />}
              {t('ssh.remote.testConnection')}
            </Button>}
            <Button
              variant="fill"
              size="sm"
              onClick={onClose}
              disabled={isConnecting || status === 'connecting'}
            >
              {t(fixedSource && !editOnly ? 'workspaceSource.backToProject' : 'actions.cancel')}
            </Button>
            {editOnly && editingProfile && <IconButton variant="quiet" size="sm" icon={<Icon name="delete" size="sm" />}
              aria-label={t('actions.delete')} disabled={sourceBusy} onClick={async event => {
                if (await handleDeleteConnection(event, editingProfile.id)) onClose();
              }} />}
            {editOnly && <Button variant="primary" size="sm" onClick={() => void handleSave()} loading={isConnecting}
              disabled={sourceBusy}>{t('actions.save')}</Button>}
            {!showNewConnection && <Button variant="primary" size="sm" disabled={sourceBusy || !selectedConnection}
              loading={isConnecting || status === 'connecting'} onClick={() => { if (selectedConnection) void handleQuickConnect(selectedConnection); }}>
              {confirmLabel ?? t('ssh.remote.connect')}
            </Button>}
            {showNewConnection && !editOnly && <Button
              variant="primary"
              size="sm"
              onClick={handleConnect}
              disabled={
                isConnecting
                || status === 'connecting'
                || (isWslTarget
                  ? wslUnavailable
                  : inheritedHost
                    ? !containerHost || !formData.containerName.trim()
                    : isLocalProcessTarget
                    ? !formData.containerName.trim()
                    : !formData.host.trim() || !formData.username.trim())
              }
            >
              {(isConnecting || status === 'connecting') ? (
                <>
                  <Loader2 size={14} className="ssh-connection-dialog__spinner" />
                  {t('ssh.remote.connecting')}
                </>
              ) : (
                <>
                  <Icon name="plus" size="sm" />
                  {confirmLabel ?? t('ssh.remote.connect')}
                </>
              )}
            </Button>}
        </DialogFooter>
      </Dialog>

      {editingPreset?.kind === 'saved' && <SSHConnectionDialog open={open}
        initialTargetType={savedConnectionTarget(editingPreset.connection)} fixedSource initialPreset={editingPreset}
        onClose={() => { setEditingPreset(undefined); void loadSavedConnections(); }} />}

      <SSHAuthPromptDialog
        open={open && credentialsPrompt !== null}
        targetDescription={credentialsPrompt ? `${credentialsPrompt.username}@${credentialsPrompt.host}:${credentialsPrompt.port}` : ''}
        defaultAuthMethod={
          credentialsPrompt?.authType.type === 'PrivateKey'
            ? 'privateKey'
            : credentialsPrompt?.authType.type === 'Agent'
              ? 'agent'
              : credentialsPrompt?.authType.type === 'KeyboardInteractive'
                ? 'keyboardInteractive'
                : 'password'
        }
        defaultKeyPath={
          credentialsPrompt?.authType.type === 'PrivateKey'
            ? credentialsPrompt.authType.keyPath
            : '~/.ssh/id_rsa'
        }
        defaultCertificatePath={
          credentialsPrompt?.authType.type === 'PrivateKey'
            ? credentialsPrompt.authType.certificatePath
            : undefined
        }
        initialUsername={credentialsPrompt?.username ?? ''}
        lockUsername
        credentialsOnly
        onSubmit={handleCredentialsPromptSubmit}
        onCancel={handleCredentialsPromptCancel}
        isConnecting={isConnecting}
      />
    </>
  );
};

export default SSHConnectionDialog;
