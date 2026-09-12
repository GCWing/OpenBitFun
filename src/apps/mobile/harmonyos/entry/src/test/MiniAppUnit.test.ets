import { describe, expect, it } from '@ohos/hypium';
import { MiniAppDocument } from '../main/ets/services/MiniAppDocument';
import { MiniAppViewModel } from '../main/ets/pages/viewmodel/MiniAppViewModel';
import { MiniAppBridgeParams, MiniAppHost, MiniAppSummary } from '../main/ets/model/MiniAppModels';

class FakeMiniAppHost implements MiniAppHost {
  calls: string[] = [];
  pendingOpen?: (html: string) => void;
  holdOpen: boolean = false;
  stored: Map<string, Object | null> = new Map();
  async list(_locale: string): Promise<MiniAppSummary[]> {
    return [{ id: 'game', name: 'Game', description: '' }, { id: 'regex', name: 'Regex', description: '' }];
  }
  async document(_id: string): Promise<string> {
    if (this.holdOpen) return new Promise<string>((resolve) => { this.pendingOpen = resolve; });
    return '<p>Game</p>';
  }
  async call(appId: string, method: string, params: MiniAppBridgeParams): Promise<Object | null> {
    this.calls.push(appId);
    const key = `${appId}:${params.key}`;
    if (method === 'storage.set') this.stored.set(key, params.value || null);
    return this.stored.get(key) || null;
  }
}

export default function miniAppUnitTest() {
  describe('MobileMiniApp', () => {
    it('opens_offline_and_binds_storage_to_selected_app_across_reopen', 0, async () => {
      const host = new FakeMiniAppHost();
      const model = new MiniAppViewModel(host);
      await model.open();
      await model.select('game');
      await model.request('{"id":"save","method":"storage.set","params":{"key":"stats","value":{"wins":3}},"app_id":"attacker"}');
      expect(host.calls[0]).assertEqual('game');
      model.close();
      await model.open();
      await model.select('regex');
      expect((await model.request('{"id":"stale","method":"storage.set","params":{"key":"stats","value":3}}', 1)).includes('error')).assertTrue();
      expect((await model.request('{"id":"get","method":"storage.get","params":{"key":"stats"}}')).includes('"result":null')).assertTrue();
      await model.open();
      await model.select('game');
      expect((await model.request('{"id":"get","method":"storage.get","params":{"key":"stats"}}')).includes('"wins":3')).assertTrue();
    });

    it('does_not_resurrect_a_closed_page_after_a_slow_open', 0, async () => {
      const host = new FakeMiniAppHost();
      const model = new MiniAppViewModel(host);
      await model.open();
      host.holdOpen = true;
      const loading = model.select('game');
      model.close();
      host.pendingOpen?.('<p>Late</p>');
      await loading;
      expect(model.state.visible).assertFalse();
      expect(model.state.document).assertEqual('');
      expect(model.state.loading).assertFalse();
    });

    it('rejects_unknown_apps_closed_pages_and_unsupported_methods', 0, async () => {
      const host = new FakeMiniAppHost();
      const model = new MiniAppViewModel(host);
      await model.open();
      await model.select('attacker');
      expect(model.state.appId).assertEqual('');
      await model.select('game');
      expect((await model.request('{"id":"bad","method":"host_invoke","params":{}}')).includes('error')).assertTrue();
      model.close();
      expect((await model.request('{"id":"bad","method":"storage.get","params":{"key":"stats"}}')).includes('error')).assertTrue();
      expect(host.calls.length).assertEqual(0);
    });

    it('keeps_app_markup_outside_the_trusted_wrapper_and_disables_network', 0, () => {
      const html = MiniAppDocument.build('</script><script>window.pwned=1</script>', 'en-US');
      expect(html.includes('</script><script>window.pwned')).assertFalse();
      expect(html.includes('sandbox="allow-scripts"')).assertTrue();
      expect(html.includes('allow-same-origin')).assertFalse();
      expect(html.includes("connect-src 'none'")).assertTrue();
      expect(html.includes('\\u003c/script>')).assertTrue();
    });
  });
}
