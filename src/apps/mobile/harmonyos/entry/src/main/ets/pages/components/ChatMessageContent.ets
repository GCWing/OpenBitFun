import { ConversationUiImage } from '../state/ConversationUiModels';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { ConversationMessageRenderPolicy } from '../policy/ConversationMessageRenderPolicy';
import { FileTargetResolver } from '../policy/FileTargetResolver';
import {
  MessageFileReference,
  MessageFileReferenceProjectionCache
} from '../policy/MessageFileReferenceProjector';
import { FileReferenceCard } from './FileReferenceCard';
import { MarkdownContent } from './MarkdownContent';
import { StreamingMarkdownContent } from './StreamingMarkdownContent';
import { LINE, MEDIA_BACKGROUND, MUTED } from './Theme';

@ComponentV2
export struct MessageImageGallery {
  @Param images: ConversationUiImage[] = [];
  @Param userStyle: boolean = false;

  build() {
    Flex({ direction: FlexDirection.Row, wrap: FlexWrap.Wrap }) {
      ForEach(this.images, (image: ConversationUiImage, index: number) => {
        Stack() {
          if (ConversationMessageRenderPolicy.hasRenderableImagePixels(image)) {
            Image(image.data_url)
              .width('100%')
              .height('100%')
              .objectFit(ImageFit.Cover)
          } else {
            // Without pixels an Image() draws an unexplained blank box, so name
            // the attachment instead and say why it is not here.
            Column() {
              Text(image.name || RemoteI18n.t('chat.image'))
                .fontSize(11)
                .fontColor(MUTED)
                .maxLines(2)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .textAlign(TextAlign.Center)
              Text(RemoteI18n.t('chat.imageUnavailable'))
                .fontSize(10)
                .fontColor(MUTED)
                .maxLines(2)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .textAlign(TextAlign.Center)
                .margin({ top: 4 })
            }
            .width('100%')
            .padding(8)
            .justifyContent(FlexAlign.Center)
          }
        }
        .width(this.userStyle ? 112 : 92)
        .height(this.userStyle ? 112 : 92)
        .backgroundColor(MEDIA_BACKGROUND)
        .borderRadius(this.userStyle ? 12 : 14)
        .border({ width: 1, color: LINE })
        .clip(true)
        .margin({
          right: this.userStyle ? (index % 2 === 0 && this.images.length > 1 ? 8 : 0) : 8,
          bottom: this.userStyle ? (index < this.images.length - 2 ? 8 : 0) : 8
        })
      }, (image: ConversationUiImage, index: number) => `${image.name}-${index}`)
    }
    .width(this.userStyle ? (this.images.length > 1 ? 232 : 112) : '100%')
  }
}

@ComponentV2
export struct MessageMarkdown {
  @Param text: string = '';
  @Param renderRevision: number = 0;
  @Param active: boolean = false;
  @Param streamKey: string = '';
  @Event onCopyText: (text: string) => void = (_text: string) => {};
  @Event onOpenLink: (reference: string, label: string) => void =
    (_reference: string, _label: string) => {};

  build() {
    if (this.active) {
      StreamingMarkdownContent({
        text: this.text,
        active: this.active,
        streamKey: this.streamKey,
        renderRevision: this.renderRevision,
        onCopyText: this.onCopyText,
        onOpenLink: this.onOpenLink
      })
    } else {
      MarkdownContent({
        text: this.text,
        renderRevision: this.renderRevision,
        onCopyText: this.onCopyText,
        onOpenLink: this.onOpenLink
      })
    }
  }
}

/**
 * Keeps a retained message object as the reactive source. Deriving text inside
 * this component avoids snapshotting a computed string through an @Builder.
 */
@ComponentV2
export struct MessageBodyMarkdown {
  @Param text: string = '';
  @Param renderRevision: number = 0;
  @Param active: boolean = false;
  @Param streamKey: string = '';
  @Event onCopyText: (text: string) => void = (_text: string) => {};
  @Event onOpenLink: (reference: string, label: string) => void =
    (_reference: string, _label: string) => {};

  build() {
    MessageMarkdown({
      text: ConversationMessageRenderPolicy.visibleText(this.text),
      renderRevision: this.renderRevision,
      active: this.active,
      streamKey: this.streamKey,
      onCopyText: this.onCopyText,
      onOpenLink: this.onOpenLink
    })
  }
}

@ComponentV2
export struct MessageFileCards {
  @Param text: string = '';
  @Param downloadingFilePath: string = '';
  @Param downloadedFilePath: string = '';
  @Param fileDownloadStatus: string = '';
  @Param activeFilePreviewPath: string = '';
  @Param activeFilePreviewLoading: boolean = false;
  @Event onPreview: (path: string, label: string) => void = (_path: string, _label: string) => {};
  @Event onDownload: (path: string) => void = (_path: string) => {};
  private readonly cache: MessageFileReferenceProjectionCache = new MessageFileReferenceProjectionCache();

  build() {
    Column({ space: 8 }) {
      ForEach(this.cache.referencesFor(this.text), (file: MessageFileReference) => {
        FileReferenceCard({
          path: file.path,
          label: file.label,
          status: this.fileStatus(file.path),
          previewLabel: RemoteI18n.t('common.open'),
          buttonLabel: this.fileButtonLabel(file.path),
          disabled: this.downloadingFilePath === file.path,
          selected: FileTargetResolver.matchesRemotePath(file.path, this.activeFilePreviewPath),
          previewLoading: this.activeFilePreviewLoading &&
            FileTargetResolver.matchesRemotePath(file.path, this.activeFilePreviewPath),
          onPreview: this.onPreview,
          onDownload: this.onDownload
        })
      }, (file: MessageFileReference) => file.id)
    }
    .width('100%')
  }

  private fileStatus(path: string): string {
    if ((this.downloadingFilePath === path || this.downloadedFilePath === path) &&
      this.fileDownloadStatus.length > 0) return this.fileDownloadStatus;
    if (path.indexOf('computer://') === 0) return RemoteI18n.t('chat.desktopFile');
    if (path.indexOf('file://') === 0) return RemoteI18n.t('chat.fileLink');
    return path;
  }

  private fileButtonLabel(path: string): string {
    if (this.downloadingFilePath === path) return RemoteI18n.t('chat.reading');
    if (this.downloadedFilePath === path) return RemoteI18n.t('common.done');
    return RemoteI18n.t('chat.download');
  }
}
