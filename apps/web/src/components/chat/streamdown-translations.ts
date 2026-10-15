import type { ComponentProps } from 'react';
import { type MessageKey, type Translate, translate } from '~/lib/i18n';

type StreamdownTranslations = NonNullable<
  ComponentProps<typeof import('streamdown').Streamdown>['translations']
>;

/**
 * The words on Streamdown's own buttons (code, diagram and table controls), as
 * catalog keys. Streamdown has English built in; we hand it the language shown,
 * and look its buttons up by the same titles (`streamdownTitle`), so naming a
 * block's controls works in every language.
 */
const KEYS = {
  close: 'chat.streamdown.close',
  copied: 'chat.streamdown.copied',
  copyCode: 'chat.streamdown.copyCode',
  copyLink: 'chat.streamdown.copyLink',
  copyTable: 'chat.streamdown.copyTable',
  copyTableAsCsv: 'chat.streamdown.copyTableAsCsv',
  copyTableAsMarkdown: 'chat.streamdown.copyTableAsMarkdown',
  copyTableAsTsv: 'chat.streamdown.copyTableAsTsv',
  downloadDiagram: 'chat.streamdown.downloadDiagram',
  downloadDiagramAsMmd: 'chat.streamdown.downloadDiagramAsMmd',
  downloadDiagramAsPng: 'chat.streamdown.downloadDiagramAsPng',
  downloadDiagramAsSvg: 'chat.streamdown.downloadDiagramAsSvg',
  downloadFile: 'chat.streamdown.downloadFile',
  downloadImage: 'chat.streamdown.downloadImage',
  downloadTable: 'chat.streamdown.downloadTable',
  downloadTableAsCsv: 'chat.streamdown.downloadTableAsCsv',
  downloadTableAsMarkdown: 'chat.streamdown.downloadTableAsMarkdown',
  exitFullscreen: 'chat.streamdown.exitFullscreen',
  externalLinkWarning: 'chat.streamdown.externalLinkWarning',
  imageNotAvailable: 'chat.streamdown.imageNotAvailable',
  mermaidFormatMmd: 'chat.streamdown.mermaidFormatMmd',
  mermaidFormatPng: 'chat.streamdown.mermaidFormatPng',
  mermaidFormatSvg: 'chat.streamdown.mermaidFormatSvg',
  openExternalLink: 'chat.streamdown.openExternalLink',
  openLink: 'chat.streamdown.openLink',
  tableFormatCsv: 'chat.streamdown.tableFormatCsv',
  tableFormatMarkdown: 'chat.streamdown.tableFormatMarkdown',
  tableFormatTsv: 'chat.streamdown.tableFormatTsv',
  viewFullscreen: 'chat.streamdown.viewFullscreen',
} as const satisfies Record<keyof StreamdownTranslations, MessageKey>;

/** Everything Streamdown says, in the language shown. */
export function streamdownTranslations(t: Translate): StreamdownTranslations {
  return Object.fromEntries(
    Object.entries(KEYS).map(([name, key]) => [name, t(key)]),
  ) as StreamdownTranslations;
}

/** The title Streamdown gives a button, in the language shown. */
export function streamdownTitle(name: keyof typeof KEYS): string {
  return translate(KEYS[name]);
}
