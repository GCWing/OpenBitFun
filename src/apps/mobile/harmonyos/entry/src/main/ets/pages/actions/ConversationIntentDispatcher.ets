import { InteractionMailboxAction } from '../../model/InteractionMailbox';
import { RemoteQuestionAnswerPayload, RemoteSession } from '../../model/RemoteModels';
import { AppRoute, AppRouteContract } from '../navigation/AppRouteContract';
import { ConversationIntent, ConversationIntentType } from './ConversationIntent';
import { toRemoteQuestionAnswer } from '../state/ConversationUiModels';
import { FilePreviewRequest } from '../../model/FilePreviewTarget';

export interface ConversationIntentDispatcherHooks {
  readonly mailbox: (action: InteractionMailboxAction) => Promise<void>;
  readonly openSidebar: () => void;
  readonly back: () => void;
  readonly newRemoteSession: () => void;
  readonly unsupported: () => void;
  readonly stop: () => Promise<void>;
  readonly loadOlder: () => Promise<void>;
  readonly approve: (toolId: string, input?: Object) => Promise<void>;
  readonly reject: (toolId: string) => Promise<void>;
  readonly cancel: (toolId: string) => Promise<void>;
  readonly answer: (toolId: string, answers: RemoteQuestionAnswerPayload) => Promise<void>;
  readonly rename: (title: string) => Promise<void>;
  readonly copy: (text: string) => Promise<void>;
  readonly retry: (text: string) => Promise<void>;
  readonly selectModel: (modelId: string) => Promise<void>;
  readonly pickImages: () => Promise<void>;
  readonly removeImage: (id: string) => void;
  readonly openFilePreview: (route: AppRoute, request: FilePreviewRequest) => void;
  readonly downloadFile: (path: string) => void;
  readonly buildPlan: (path: string, name: string) => Promise<void>;
  readonly send: () => Promise<void>;
  readonly voiceInput: () => Promise<void>;
  readonly inputChanged: (route: AppRoute, value: string) => void;
}

export class ConversationIntentDispatcher {
  private readonly hooks: ConversationIntentDispatcherHooks;

  constructor(hooks: ConversationIntentDispatcherHooks) {
    this.hooks = hooks;
  }

  dispatch(route: AppRoute, intent: ConversationIntent): void {
    switch (intent.type) {
      case ConversationIntentType.Mailbox: if (intent.mailboxAction) void this.hooks.mailbox(intent.mailboxAction); return;
      case ConversationIntentType.OpenSidebar: this.hooks.openSidebar(); return;
      case ConversationIntentType.Back: this.hooks.back(); return;
      case ConversationIntentType.NewSession: this.hooks.newRemoteSession(); return;
      case ConversationIntentType.TogglePin:
      case ConversationIntentType.Archive:
      case ConversationIntentType.Delete:
      case ConversationIntentType.ShowUploadedFiles:
        this.hooks.unsupported(); return;
      case ConversationIntentType.Stop: void this.hooks.stop(); return;
      case ConversationIntentType.LoadOlder: void this.hooks.loadOlder(); return;
      case ConversationIntentType.ApproveTool: void this.hooks.approve(intent.toolId, intent.updatedInput); return;
      case ConversationIntentType.RejectTool: void this.hooks.reject(intent.toolId); return;
      case ConversationIntentType.CancelTool: void this.hooks.cancel(intent.toolId); return;
      case ConversationIntentType.AnswerQuestion:
        if (intent.answers) void this.hooks.answer(intent.toolId, toRemoteQuestionAnswer(intent.answers)); return;
      case ConversationIntentType.RenameSession: void this.hooks.rename(intent.value); return;
      case ConversationIntentType.CopyMessage: void this.hooks.copy(intent.value); return;
      case ConversationIntentType.RetryMessage: void this.hooks.retry(intent.value); return;
      case ConversationIntentType.SelectModel: void this.hooks.selectModel(intent.value); return;
      case ConversationIntentType.PickImages: void this.hooks.pickImages(); return;
      case ConversationIntentType.RemoveImage: this.hooks.removeImage(intent.value); return;
      case ConversationIntentType.OpenFilePreview:
        if (intent.filePreviewRequest) this.hooks.openFilePreview(route, intent.filePreviewRequest); return;
      case ConversationIntentType.DownloadFile: this.hooks.downloadFile(intent.value); return;
      case ConversationIntentType.BuildPlan:
        if (route === AppRoute.RemoteChat && intent.planBuildRequest) {
          void this.hooks.buildPlan(intent.planBuildRequest.path, intent.planBuildRequest.name);
        }
        return;
      case ConversationIntentType.Send: void this.hooks.send(); return;
      case ConversationIntentType.VoiceInput: void this.hooks.voiceInput(); return;
      case ConversationIntentType.ChatInputChanged: this.hooks.inputChanged(route, intent.value); return;
    }
  }

}
