import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigAPI } from './ConfigAPI';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('./ApiClient', () => ({
  api: {
    invoke: invokeMock,
  },
}));

describe('ConfigAPI batch config reads', () => {
  let configAPI: ConfigAPI;

  beforeEach(() => {
    configAPI = new ConfigAPI();
    invokeMock.mockReset();
  });

  it('reads multiple config paths through one batch command', async () => {
    const configs = {
      'ai.models': [],
      'ai.default_models': { chat: 'gpt-5' },
    };
    invokeMock.mockResolvedValueOnce(configs);

    await expect(
      configAPI.getConfigs(['ai.models', 'ai.models', 'ai.default_models'])
    ).resolves.toEqual(configs);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('get_configs', {
      request: {
        paths: ['ai.models', 'ai.default_models'],
        skipRetryOnNotFound: false,
      },
    });
  });

  it('falls back to existing single-path reads when the batch command fails', async () => {
    invokeMock.mockImplementation((command: string, args?: any) => {
      if (command === 'get_configs') {
        return Promise.reject(new Error('unknown command get_configs'));
      }

      return Promise.resolve(`value:${args.request.path}`);
    });

    await expect(configAPI.getConfigs(['ai.models', 'ai.default_models'])).resolves.toEqual({
      'ai.models': 'value:ai.models',
      'ai.default_models': 'value:ai.default_models',
    });

    expect(invokeMock).toHaveBeenCalledTimes(3);
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'get_configs', {
      request: {
        paths: ['ai.models', 'ai.default_models'],
        skipRetryOnNotFound: false,
      },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'get_config', {
      request: {
        path: 'ai.models',
        skipRetryOnNotFound: false,
      },
    }, undefined);
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'get_config', {
      request: {
        path: 'ai.default_models',
        skipRetryOnNotFound: false,
      },
    }, undefined);
  });

  it('saves cloud speech configuration through one domain command', async () => {
    invokeMock.mockResolvedValueOnce({ modelId: 'speech-1', created: true });

    await expect(configAPI.saveCloudSpeechConfig({
      preset: 'qwen',
      name: 'Qwen ASR',
      baseUrl: 'https://example.com/v1',
      requestUrl: 'https://example.com/v1/audio/transcriptions',
      modelName: 'qwen-asr',
      apiKey: 'secret',
    })).resolves.toEqual({ modelId: 'speech-1', created: true });

    expect(invokeMock).toHaveBeenCalledWith('save_cloud_speech_config', {
      request: {
        preset: 'qwen',
        name: 'Qwen ASR',
        baseUrl: 'https://example.com/v1',
        requestUrl: 'https://example.com/v1/audio/transcriptions',
        modelName: 'qwen-asr',
        apiKey: 'secret',
      },
    });
  });

  it('keeps WebSearch credentials on the dedicated secret commands', async () => {
    invokeMock
      .mockResolvedValueOnce({ provider: 'tavily', configured: false })
      .mockResolvedValueOnce({ provider: 'tavily', configured: true })
      .mockResolvedValueOnce({ provider: 'tavily', configured: false });

    await configAPI.getWebSearchCredentialStatus('tavily');
    await configAPI.saveWebSearchCredential('tavily', 'tvly-secret');
    await configAPI.clearWebSearchCredential('tavily');

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'get_web_search_credential_status', {
      request: { provider: 'tavily' },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'save_web_search_credential', {
      request: { provider: 'tavily', secret: 'tvly-secret' },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'clear_web_search_credential', {
      request: { provider: 'tavily' },
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      'set_config',
      expect.objectContaining({ request: expect.objectContaining({ value: 'tvly-secret' }) }),
    );
  });

  it('bounds Skill catalog requests at sixty seconds', async () => {
    invokeMock.mockResolvedValue([]);

    await configAPI.getSkillConfigs({ workspaceId: 'remote-workspace-id' });
    await configAPI.getModeSkillConfigs({
      modeId: 'Standard',
      workspaceId: 'remote-workspace-id',
    });

    expect(invokeMock).toHaveBeenNthCalledWith(
      1,
      'get_skill_configs',
      { forceRefresh: undefined, workspaceId: 'remote-workspace-id' },
      { timeout: 60_000 },
    );
    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      'get_mode_skill_configs',
      {
        modeId: 'Standard',
        forceRefresh: undefined,
        workspaceId: 'remote-workspace-id',
      },
      { timeout: 60_000 },
    );
  });

  it('rejects unsuccessful imports without attaching credential-bearing documents to errors', async () => {
    invokeMock.mockResolvedValueOnce({ success: false, errors: ['Invalid config'], warnings: [] });
    const document = { config: { app: { voice_call: { api_key: 'fixture-import-key' } } } };

    const error = await configAPI.importConfig(document).catch(error => error);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('Invalid config');
    expect(error.context.request).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain('fixture-import-key');
  });

  it('accepts a confirmed import and rejects an ambiguous response', async () => {
    invokeMock.mockResolvedValueOnce({ success: true, errors: [], warnings: [] });
    await expect(configAPI.importConfig({})).resolves.toBeUndefined();

    invokeMock.mockResolvedValueOnce(undefined);
    await expect(configAPI.importConfig({})).rejects.toThrow('Configuration import was not confirmed');
  });
});


describe('direct Skill availability wire compatibility', () => {
  it('keeps user-only requests compatible and scopes project switches explicitly', async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ globallyDisabledUserSkillKeys: [] });
    const config = new ConfigAPI();
    const legacy = await config.getGlobalSkillSettings();
    expect(invokeMock).toHaveBeenLastCalledWith('get_global_skill_settings', undefined);
    expect(legacy.directSkillManagementVersion).toBeUndefined();
    await config.getGlobalSkillSettings('workspace-a');
    expect(invokeMock).toHaveBeenLastCalledWith('get_global_skill_settings', { request: { workspaceId: 'workspace-a' } });
    await config.setGlobalSkillDisabled({ skillKey: 'user::home.agents::review', disabled: true });
    expect(invokeMock).toHaveBeenLastCalledWith('set_global_skill_disabled', { request: { skillKey: 'user::home.agents::review', disabled: true } });
    await config.setGlobalSkillDisabled({ skillKey: 'project::agents::review', disabled: false, workspaceId: 'workspace-a' });
    expect(invokeMock).toHaveBeenLastCalledWith('set_global_skill_disabled', { request: { skillKey: 'project::agents::review', disabled: false, workspaceId: 'workspace-a' } });
  });
});

describe('skill scan response compatibility', () => {
  it('accepts legacy arrays and marks diagnostics as unavailable', async () => {
    invokeMock.mockResolvedValueOnce([{ key: 'user::codex::pdf', name: 'pdf' }]);
    const report = await new ConfigAPI().getSkillScanReport();
    expect(report.skills).toHaveLength(1);
    expect(report.diagnosticsAvailable).toBe(false);
    expect(report.diagnostics).toEqual([]);
  });

  it('preserves partial inventories and diagnostics from new hosts', async () => {
    const value = { skills: [{ key: 'project::codex::pdf' }], diagnostics: [{ path: '/remote/denied', sourceId: 'codex', message: 'permission denied' }] };
    invokeMock.mockResolvedValueOnce(value);
    expect(await new ConfigAPI().getModeSkillScanReport({ modeId: 'agent', workspaceId: 'remote-workspace-id' }))
      .toEqual({ ...value, diagnosticsAvailable: true });
  });

  it('rejects malformed responses rather than presenting an empty inventory', async () => {
    invokeMock.mockResolvedValueOnce({ invalid: true });
    await expect(new ConfigAPI().getSkillScanReport()).rejects.toThrow();
  });
});

describe('reviewed Skill import wire compatibility', () => {
  it('preserves legacy validation and sends the reviewed digest only when supplied', async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ valid: true });
    const config = new ConfigAPI();
    await config.validateSkillPath('/source');
    expect(invokeMock).toHaveBeenLastCalledWith('validate_skill_path', { path: '/source' });
    await config.validateSkillPath('/source', { sourceKey: 'external-key', workspaceId: 'workspace-id' });
    expect(invokeMock).toHaveBeenLastCalledWith('validate_skill_path', { path: '/source', sourceKey: 'external-key', workspaceId: 'workspace-id' });
    await config.addSkill({ sourcePath: '/source', level: 'user', sourceKey: 'external-key', expectedSourceFingerprint: 'reviewed', targetName: 'alias' });
    expect(invokeMock).toHaveBeenLastCalledWith('add_skill', { sourcePath: '/source', level: 'user', workspaceId: undefined, sourceKey: 'external-key', expectedSourceFingerprint: 'reviewed', targetName: 'alias' });
    await config.addSkill({ sourcePath: '/source', level: 'user' });
    expect(invokeMock).toHaveBeenLastCalledWith('add_skill', { sourcePath: '/source', level: 'user', workspaceId: undefined });
  });

  it('retains the advertised reviewed-import version', async () => {
    invokeMock.mockResolvedValueOnce({ skills: [], diagnostics: [], importOperationsVersion: 3 });
    expect((await new ConfigAPI().getSkillScanReport()).importOperationsVersion).toBe(3);
  });
});
