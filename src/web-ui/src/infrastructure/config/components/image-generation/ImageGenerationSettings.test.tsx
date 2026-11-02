// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIModelConfig, MediaConfig } from '../../types';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { getSettingsDraftSnapshot } from '../../settingsDraftRegistry';
import { ImageGenerationAcquisitionRow, ImageGenerationDefaultSlot, ImageGenerationDialogs } from './ImageGenerationSection';
import { useImageGenerationSettings, type ImageGenerationSettings } from './useImageGenerationSettings';
import DefaultModelConfig from '../DefaultModelConfig';
import { imageServiceFromSubscriptionModel } from './imageModels';
import type { ImageServiceTestOutcome } from '@/infrastructure/api/service-api/MediaApi';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ get: vi.fn(), getModels: vi.fn(), update: vi.fn(), success: vi.fn(), error: vi.fn(), test: vi.fn() }));
vi.mock('../../services/ConfigManager', () => ({ configManager: {
  hasCachedConfig: () => false, getCachedConfig: () => undefined,
  getConfig: mocks.get, getOptionalConfig: mocks.getModels, updateConfig: mocks.update, watch: () => () => {},
} }));
vi.mock('@/shared/notification-system', () => ({ useNotification: () => ({ success: mocks.success, error: mocks.error }), notificationService: { success: mocks.success, error: mocks.error } }));
vi.mock('../ModelSelectPresentation', () => ({ useModelSelectPresentation: () => ({ buildModelOption: (model: AIModelConfig) => ({ label: model.model_name, value: model.id }) }) }));
vi.mock('react-i18next', async original => ({ ...await original<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/infrastructure/api/service-api/MediaApi', () => ({ mediaAPI: { testImageGenerationService: mocks.test } }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, formatNumber: String }) }));

const subscription: AIModelConfig = {
  id: 'configured-codex', name: 'My subscription', provider: 'openai', model_name: 'account-chat-model',
  base_url: 'https://chatgpt.com/backend-api/codex', api_key: 'unused-chat-secret', enabled: true,
  auth: { type: 'subscription', provider: 'codex' }, category: 'general_chat', capabilities: ['text_chat'],
};
const legacy: MediaConfig = { image_services: [{ id: 'legacy', name: 'Saved image', dialect: 'openai_images',
  base_url: 'https://images.example/v1', request_url: 'https://images.example/v1/images/generations',
  model_name: 'image-model', api_key: 'saved-image-key', enabled: true, params: { size: '1024x1024', n: 1, seed: 42 },
  custom_headers: { 'X-Tenant': 'kept' }, auth: { type: 'api_key' } }], default_image_service: 'legacy' };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

describe('image models in model settings', () => {
  let host: HTMLDivElement;
  let root: Root;
  let media: MediaConfig;
  let settings: ImageGenerationSettings;
  function Fixture({ models = [subscription] }: { models?: AIModelConfig[] }) {
    settings = useImageGenerationSettings();
    return <><section data-testid="acquisition"><ImageGenerationAcquisitionRow settings={settings} /></section>
      <section data-testid="all-models"><DefaultModelConfig compact models={models} defaultModels={{}} loading={false} disabled={false}
        onDefaultModelsChange={() => {}} imageGenerationSlot={<ImageGenerationDefaultSlot settings={settings} />} /></section>
      <ImageGenerationDialogs settings={settings} /></>;
  }
  const render = async (models?: AIModelConfig[]) => act(async () => { if (models) mocks.getModels.mockResolvedValue(models); root.render(<Fixture models={models} />); });
  const click = async (element: HTMLElement) => act(async () => { element.focus(); element.click(); });
  const choose = async (testId: string, label: string) => {
    const control = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;
    await click(control.matches('button') ? control : control.querySelector<HTMLElement>('button[data-openbitfun-part="trigger"]')!);
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(element => element.textContent?.includes(label));
    expect(option, `option ${label}`).toBeTruthy(); await click(option!);
  };
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent === label)!;
  const confirmation = () => document.querySelector<HTMLElement>('[role="alertdialog"]:not([aria-hidden="true"])');
  const confirmationButton = (label: string) => [...confirmation()!.querySelectorAll<HTMLButtonElement>('button')]
    .find(element => element.textContent === label)!;
  const openSavedEditor = async () => {
    await render();
    await click([...host.querySelectorAll<HTMLButtonElement>('[data-testid="acquisition"] button')]
      .find(element => element.textContent?.includes('Saved image'))!);
    return document.querySelector<HTMLElement>('[role="dialog"]:not([aria-hidden="true"])')!;
  };

  beforeEach(() => {
    activateSurface('local');
    media = JSON.parse(JSON.stringify(legacy));
    mocks.get.mockReset().mockImplementation(async () => media);
    mocks.getModels.mockReset().mockResolvedValue([subscription]);
    mocks.update.mockReset().mockImplementation(async (_path, update) => { media = update(media); return media; });
    mocks.success.mockReset(); mocks.error.mockReset(); mocks.test.mockReset();
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); activateSurface('local'); });

  it('requires billing confirmation and only shows verification after an image is returned', async () => {
    const pending = deferred<ImageServiceTestOutcome>();
    mocks.test.mockReturnValueOnce(pending.promise);
    const editor = await openSavedEditor();
    expect(editor.textContent).not.toContain('wizard.steps.test.label');
    expect(editor.textContent).not.toContain('wizard.test.billed');

    await click(button('wizard.test.run'));
    expect(confirmation()?.textContent).toContain('wizard.test.billed');
    expect(mocks.test).not.toHaveBeenCalled();
    await click(confirmationButton('actions.cancel'));
    expect(confirmation()).toBeNull();
    expect(mocks.test).not.toHaveBeenCalled();

    await click(button('wizard.test.run'));
    await click(confirmationButton('wizard.test.run'));
    expect(confirmation()).toBeNull();
    expect(mocks.test).toHaveBeenCalledTimes(1);
    expect(mocks.test.mock.calls[0][0]).toMatchObject({ id: 'legacy', model_name: 'image-model' });
    expect(editor.textContent).not.toContain('wizard.steps.test.label');
    expect(editor.querySelector('img')).toBeNull();
    expect(button('wizard.test.run').disabled).toBe(true);

    await act(async () => pending.resolve({ success: true, elapsed_ms: 10, mime: 'image/png', image_base64: 'dGVzdA==' }));
    expect(editor.textContent).toContain('wizard.steps.test.label');
    expect(editor.textContent).not.toContain('wizard.test.billed');
    expect(editor.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,dGVzdA==');
    expect(button('wizard.test.run').disabled).toBe(false);

    const field = [...editor.querySelectorAll<HTMLElement>('.openbitfun-config-page-row')]
      .find(element => element.textContent?.includes('wizard.fields.modelName.label'))!.querySelector<HTMLInputElement>('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'updated-image-model');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(editor.textContent).not.toContain('wizard.steps.test.label');
    expect(editor.querySelector('img')).toBeNull();
  });

  it.each([
    { result: { success: false, elapsed_ms: 0, error_kind: 'auth' }, error: 'auth' },
    { result: { success: true, elapsed_ms: 10 }, error: 'empty_result' },
    { result: new Error('host offline'), error: 'transport' },
  ] as const)('reports $error without showing the image verification section', async ({ result, error }) => {
    if (result instanceof Error) mocks.test.mockRejectedValueOnce(result);
    else mocks.test.mockResolvedValueOnce(result);
    const editor = await openSavedEditor();
    await click(button('wizard.test.run'));
    await click(confirmationButton('wizard.test.run'));
    expect(editor.querySelector('[role="alert"]')?.textContent).toContain(`wizard.errors.${error}`);
    expect(editor.textContent).not.toContain('wizard.steps.test.label');
    expect(editor.querySelector('img')).toBeNull();
    expect(button('wizard.test.run').disabled).toBe(false);
  });

  it.each(['confirmation', 'generation'])('clears test %s when switching execution hosts', async stage => {
    const pending = deferred<ImageServiceTestOutcome>();
    mocks.test.mockReturnValueOnce(pending.promise);
    await openSavedEditor();
    await click(button('wizard.test.run'));
    if (stage === 'generation') await click(confirmationButton('wizard.test.run'));
    mocks.get.mockResolvedValue({ image_services: [] });
    mocks.getModels.mockResolvedValue([]);
    await act(async () => { activateSurface('next-host'); });
    expect(confirmation()).toBeNull();
    expect(mocks.test).toHaveBeenCalledTimes(stage === 'generation' ? 1 : 0);
    await act(async () => pending.resolve({ success: true, elapsed_ms: 10, mime: 'image/png', image_base64: 'dGVzdA==' }));
    expect(document.querySelector('[role="dialog"]:not([aria-hidden="true"])')).toBeNull();
    expect(document.querySelector('img[alt="wizard.test.previewAlt"]')).toBeNull();
  });

  it('selects an already configured subscription as the image default without changing chat defaults', async () => {
    await render();
    await choose('image-service-default-select', 'account-chat-model');
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update.mock.calls[0][0]).toBe('media');
    expect(media.default_image_service).toBe('configured-image:configured-codex');
    expect(media.image_services[0]).toEqual(legacy.image_services[0]);
    expect(media.image_services[1]).toMatchObject({ dialect: 'chatgpt_codex', model_name: 'account-chat-model', api_key: '', auth: subscription.auth });
    expect(host.querySelector('[data-testid="acquisition"]')?.textContent).toContain('My subscription');
  });

  it('keeps explicit accounts separate and excludes account pools from image imports', async () => {
    const first: AIModelConfig = { ...subscription, auth: { type: 'subscription', provider: 'codex', account_id: 'account-a' } };
    const second: AIModelConfig = { ...subscription, id: 'second-account', auth: { type: 'subscription', provider: 'codex', account_id: 'account-b' } };
    const pool: AIModelConfig = { ...subscription, id: 'account-pool', auth: { type: 'subscription_pool', provider: 'codex', accounts: ['account-a', 'account-b'], revision: 1 } };
    await render([first, second, pool]);
    expect(settings.credentials).toHaveLength(2);
    expect(settings.configuredModels).toHaveLength(2);
    await act(async () => { await settings.selectDefault('configured:configured-codex'); });
    expect(media.image_services.at(-1)?.auth).toEqual(first.auth);
    expect(settings.configuredModels.map(model => model.id)).toEqual(['second-account']);
  });

  it('keeps a persisted image account pool visible but disables unsupported editing and generation', async () => {
    media = { ...legacy, image_services: [{ ...legacy.image_services[0], auth: { type: 'subscription_pool', provider: 'codex', accounts: ['account-a'], revision: 1 } }] };
    await render();
    await click([...host.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent?.includes('Saved image'))!);
    expect(button('actions.save').disabled).toBe(true);
    expect(button('wizard.test.run').disabled).toBe(true);
    expect(button('actions.save').title).toBe('wizard.validation.unsupportedAuth');
    expect(media.image_services[0].auth?.type).toBe('subscription_pool');
  });

  it('imports a subscription using the same picker flow without showing duplicate connection fields', async () => {
    await render(); await click(host.querySelector<HTMLElement>('[data-testid="image-service-add"]')!);
    await choose('image-service-source', 'My subscription');
    expect(document.querySelector('[role="dialog"] input[type="password"]')).toBeNull();
    expect(document.querySelector('[data-testid="image-service-advanced"]')).toBeNull();
    expect(document.querySelector('[role="dialog"] input')).toBeNull();
    await click(button('actions.save'));
    expect(media.image_services.at(-1)).toMatchObject({ name: 'My subscription', dialect: 'chatgpt_codex', model_name: '', api_key: '' });
    expect(media.image_services.at(-1)?.params.size).toBeUndefined();
    expect(document.querySelector('[role="dialog"]:not([aria-hidden="true"])')).toBeNull();
    expect(mocks.test).not.toHaveBeenCalled();
  });

  it('blocks repeated provider imports in the dialog and at save time', async () => {
    await render();
    await click(host.querySelector<HTMLElement>('[data-testid="image-service-add"]')!);
    await choose('image-service-source', 'My subscription');
    await click(button('actions.save'));
    const imported = media.image_services.at(-1)!;
    await click(host.querySelector<HTMLElement>('[data-testid="image-service-add"]')!);
    await choose('image-service-source', 'My subscription');
    expect(button('actions.save').disabled).toBe(true);
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe('wizard.validation.duplicate');
    await act(async () => { expect(await settings.saveService({ ...imported, id: 'new-id', name: 'Renamed' })).toBe(false); });
    expect(media.image_services).toHaveLength(2);
    expect(media.default_image_service).toBe('legacy');
    expect(mocks.error).toHaveBeenLastCalledWith('wizard.validation.duplicate');
    expect(mocks.test).not.toHaveBeenCalled();
  });

  it('checks fresh persisted config when another window has already saved the same manual configuration', async () => {
    await render();
    const original = media;
    mocks.update.mockImplementationOnce(async (_path, update) => {
      media = { ...media, image_services: [...media.image_services, { ...legacy.image_services[0], id: 'other-window', model_name: 'new-image' }] };
      media = update(media);
      return media;
    });
    await act(async () => {
      expect(await settings.saveService({ ...legacy.image_services[0], id: 'new-draft', model_name: 'new-image' })).toBe(false);
    });
    expect(media.image_services.map(service => service.id)).toEqual(['legacy', 'other-window']);
    expect(media.default_image_service).toBe(original.default_image_service);
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith('wizard.validation.duplicate');
  });

  it('reuses an imported disabled service when its configured model becomes the default', async () => {
    const imported = { ...imageServiceFromSubscriptionModel(subscription), id: 'manually-imported', enabled: false };
    media = { ...legacy, image_services: [...legacy.image_services, imported] };
    await render();
    await choose('image-service-default-select', 'account-chat-model');
    expect(media.default_image_service).toBe('manually-imported');
    expect(media.image_services).toHaveLength(2);
    expect(media.image_services.find(service => service.id === imported.id)).toMatchObject({ enabled: true });
  });

  it('preserves existing advanced parameters and the open draft after a failed save', async () => {
    await render(); await click([...host.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent?.includes('Saved image'))!);
    const field = [...document.querySelectorAll<HTMLElement>('.openbitfun-config-page-row')].find(element => element.textContent?.includes('wizard.fields.modelName.label'))!.querySelector<HTMLInputElement>('input')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'updated-image-model'); field.dispatchEvent(new Event('input', { bubbles: true })); });
    mocks.update.mockRejectedValueOnce(new Error('host offline'));
    await click(button('actions.save'));
    expect(document.querySelector('[role="dialog"]:not([aria-hidden="true"])')).not.toBeNull();
    expect(field.value).toBe('updated-image-model');
    expect(getSettingsDraftSnapshot().resources.find(item => item.id === 'image-generation-editor')?.dirty).toBe(true);
    expect(media).toEqual(legacy);
    await click(button('actions.save'));
    expect(media.image_services[0]).toMatchObject({ model_name: 'updated-image-model', params: legacy.image_services[0].params, custom_headers: legacy.image_services[0].custom_headers });
    expect(media.default_image_service).toBe('legacy');
  });

  it('shows the effective legacy request address without exposing generation defaults', async () => {
    await render();
    await click([...host.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent?.includes('Saved image'))!);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect([...dialog.querySelectorAll('input')].map(input => input.value)).toContain(legacy.image_services[0].request_url);
    for (const field of ['name', 'size', 'n', 'quality', 'background', 'negativePrompt', 'watermark', 'promptExtend', 'requestUrl']) {
      expect(dialog.textContent).not.toContain(`wizard.fields.${field}.label`);
    }
    const address = [...dialog.querySelectorAll('input')].find(input => input.value === legacy.image_services[0].request_url)!;
    const updatedAddress = 'https://images.example/custom/generate';
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(address, updatedAddress);
      address.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button('actions.save'));
    expect(media.image_services[0]).toMatchObject({
      request_url: updatedAddress,
      base_url: legacy.image_services[0].base_url,
      params: legacy.image_services[0].params,
      custom_headers: legacy.image_services[0].custom_headers,
    });
    expect(mocks.test).not.toHaveBeenCalled();
  });

  it('keeps an image-only configuration selectable when there are no chat models', async () => {
    await render([]);
    const control = host.querySelector<HTMLButtonElement>('[data-testid="image-service-default-select"] button')!;
    expect(control.disabled).toBe(false);
    await choose('image-service-default-select', 'Saved image');
    expect(media.default_image_service).toBe('legacy');
  });

  it('does not overwrite a configuration when its initial load failed', async () => {
    mocks.get.mockRejectedValueOnce(new Error('host offline'));
    await render();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="image-service-add"]')!.disabled).toBe(true);
    await act(async () => { expect(await settings.saveService(legacy.image_services[0])).toBe(false); });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('persists the first enabled image default and lets a manual selection survive reloads', async () => {
    media = { image_services: [...legacy.image_services, { ...legacy.image_services[0], id: 'second', model_name: 'second-image-model' }] };
    await render([]);
    expect(media.default_image_service).toBe('legacy');
    expect(settings.selectedId).toBe('legacy');
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.success).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('default.ambiguous');
    expect(host.querySelector('[data-testid="image-service-default-select"]')?.textContent).toContain('Saved image');
    expect(host.querySelector('[aria-invalid="true"]')).toBeNull();
    await choose('image-service-default-select', 'second-image-model');
    expect(media.default_image_service).toBe('second');
    await act(async () => { await settings.load(); });
    expect(settings.selectedId).toBe('second');
    expect(mocks.update).toHaveBeenCalledTimes(2);
  });

  it('replaces an unavailable default and falls back when the chosen service is disabled', async () => {
    media = { image_services: [{ ...legacy.image_services[0], id: 'disabled', enabled: false }, ...legacy.image_services,
      { ...legacy.image_services[0], id: 'second' }], default_image_service: 'disabled' };
    await render([]);
    expect(media.default_image_service).toBe('legacy');
    await act(async () => { await settings.toggle(media.image_services[1], false); });
    expect(media.default_image_service).toBe('second');
    expect(media.image_services).toHaveLength(3);
  });

  it('does not repeatedly retry a failed automatic default save and permits manual retry', async () => {
    media = { image_services: legacy.image_services };
    mocks.update.mockRejectedValueOnce(new Error('host offline'));
    await render([]);
    await render([]);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.error).toHaveBeenCalledTimes(1);
    await choose('image-service-default-select', 'Saved image');
    expect(media.default_image_service).toBe('legacy');
    expect(mocks.update).toHaveBeenCalledTimes(2);
  });

  it('keeps a default selected by another editor while initializing the default', async () => {
    media = { image_services: [...legacy.image_services, { ...legacy.image_services[0], id: 'second' }] };
    mocks.update.mockImplementationOnce(async (_path, update) => {
      media = update({ ...media, default_image_service: 'second' });
      return media;
    });
    await render([]);
    expect(media.default_image_service).toBe('second');
    expect(settings.selectedId).toBe('second');
  });

  it('closes drafts and resets the list while the next execution host loads', async () => {
    const pending = deferred<MediaConfig>();
    await render(); await click(host.querySelector<HTMLElement>('[data-testid="image-service-add"]')!);
    mocks.get.mockImplementation(async () => pending.promise);
    await act(async () => { activateSurface('peer-device'); });
    expect(document.querySelector('[role="dialog"]:not([aria-hidden="true"])')).toBeNull();
    await act(async () => { pending.resolve({ image_services: [] }); });
    expect(settings.media.image_services).toEqual([]);
    expect(host.textContent).not.toContain('Saved image');
  });

  it('imports provider connection details without using a chat model as the image model', async () => {
    const apiModel: AIModelConfig = { ...subscription, id: 'api-image', name: 'Image gateway', model_name: 'my-image-model',
      base_url: 'https://images.example/v1', request_url: 'https://images.example/v1/chat/completions',
      auth: { type: 'api_key' }, api_key: 'image-secret', custom_headers: { 'X-Tenant': 'image-tenant' } };
    await render([apiModel]); await click(host.querySelector<HTMLElement>('[data-testid="image-service-add"]')!);
    await choose('image-service-source', 'Image gateway'); await click(button('actions.save'));
    expect(media.image_services.at(-1)).toMatchObject({ name: 'Image gateway', dialect: 'openai_images', model_name: 'gpt-image-1',
      base_url: 'https://images.example/v1', api_key: 'image-secret', custom_headers: { 'X-Tenant': 'image-tenant' } });
    expect(media.image_services.at(-1)?.request_url).toBeUndefined();
  });

  it('lists each provider instance once while keeping separate providers selectable', async () => {
    await render([
      { ...subscription, metadata: { provider_instance_id: 'subscription-provider' } },
      { ...subscription, id: 'second-chat-model', model_name: 'other-chat-model', metadata: { provider_instance_id: 'subscription-provider' } },
      { ...subscription, id: 'another-provider', name: 'Other subscription', metadata: { provider_instance_id: 'other-provider' } },
    ]);
    await click(host.querySelector<HTMLElement>('[data-testid="image-service-add"]')!);
    await click(document.querySelector<HTMLElement>('[data-testid="image-service-source"] button[data-openbitfun-part="trigger"]')!);
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options.map(option => option.textContent)).toEqual(['import.manual', 'My subscription', 'Other subscription']);
    expect(options.some(option => option.textContent?.includes('chat-model'))).toBe(false);
    expect(settings.credentials).toHaveLength(2);
  });

  it('groups legacy provider connections without mixing distinct keys or endpoints', async () => {
    const apiModel: AIModelConfig = { ...subscription, auth: { type: 'api_key' }, name: 'Gateway - chat-one', model_name: 'chat-one' };
    await render([
      apiModel, { ...apiModel, id: 'second-model', name: 'Gateway/chat-two', model_name: 'chat-two', base_url: `${apiModel.base_url}/` },
      { ...apiModel, id: 'other-key', name: 'Other account', api_key: 'another-secret' },
      { ...apiModel, id: 'other-endpoint', name: 'Other endpoint', base_url: 'https://other.example/v1' },
    ]);
    expect(settings.credentials.map(credential => credential.label)).toEqual(['Gateway', 'Other account', 'Other endpoint']);
    expect(settings.credentials.map(credential => credential.id)).toEqual(['configured-codex', 'other-key', 'other-endpoint']);
  });

  it('ignores a completed read from the previous host', async () => {
    const oldRead = deferred<MediaConfig>();
    mocks.get.mockReturnValueOnce(oldRead.promise);
    await render();
    mocks.get.mockResolvedValue({ image_services: [] });
    await act(async () => { activateSurface('next-host'); });
    await act(async () => { oldRead.resolve(legacy); });
    expect(settings.media.image_services).toEqual([]);
    expect(host.textContent).not.toContain('Saved image');
  });

  it('does not apply an old host save result or success notification after activation changes', async () => {
    await render();
    const oldSave = deferred<MediaConfig>();
    mocks.update.mockReturnValueOnce(oldSave.promise);
    let save!: Promise<void>;
    await act(async () => { save = settings.selectDefault('configured:configured-codex'); });
    mocks.get.mockResolvedValue({ image_services: [] });
    await act(async () => { activateSurface('next-host'); });
    await act(async () => { oldSave.resolve(legacy); await save; });
    expect(settings.media.image_services).toEqual([]);
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it('does not offer or copy the previous device credentials while the next device model list loads', async () => {
    await render();
    const nextModels = deferred<AIModelConfig[]>();
    mocks.getModels.mockReturnValueOnce(nextModels.promise);
    mocks.get.mockResolvedValue({ image_services: [] });
    await act(async () => { activateSurface('next-host'); });
    expect(settings.credentials).toEqual([]);
    await act(async () => { await settings.selectDefault('configured:configured-codex'); });
    expect(mocks.update).not.toHaveBeenCalled();
    await act(async () => { nextModels.resolve([]); });
    expect(settings.configuredModels).toEqual([]);
    expect(settings.credentials).toEqual([]);
  });
});
