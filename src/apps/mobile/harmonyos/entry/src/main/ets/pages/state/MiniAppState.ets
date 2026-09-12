import { MiniAppSummary } from '../../model/MiniAppModels';

@ObservedV2
export class MiniAppState {
  @Trace visible: boolean = false;
  @Trace loading: boolean = false;
  @Trace error: string = '';
  @Trace apps: MiniAppSummary[] = [];
  @Trace appId: string = '';
  @Trace name: string = '';
  @Trace document: string = '';
  @Trace revision: number = 0;
}
