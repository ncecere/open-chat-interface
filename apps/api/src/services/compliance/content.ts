import { isToolPart, summarizeToolPart, toolIdOfPart } from '@oci/shared';

/**
 * What a compliance export says about one message: the text people read,
 * one line per tool step, the names of attached files and cited sources.
 * Never attachment bytes, raw tool results or model reasoning.
 */

type Part = Record<string, unknown>;

export interface ExportedToolStep {
  toolCallId: string;
  tool: string;
  state: string;
  summary: string;
}

export interface ExportedFile {
  attachmentId: string | null;
  filename: string;
  mediaType: string | null;
}

export interface MessageContent {
  text: string;
  toolSteps: ExportedToolStep[];
  files: ExportedFile[];
  sources: string[];
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export function summarizeMessageParts(parts: unknown): MessageContent {
  const list = Array.isArray(parts)
    ? parts.filter((part): part is Part => typeof part === 'object' && part !== null)
    : [];
  const text: string[] = [];
  const toolSteps: ExportedToolStep[] = [];
  const files: ExportedFile[] = [];
  const sources: string[] = [];

  for (const part of list) {
    if (part.type === 'text') {
      const value = str(part.text);
      if (value?.trim()) text.push(value);
    } else if (isToolPart(part)) {
      const step = summarizeToolPart(part);
      toolSteps.push({
        toolCallId: part.toolCallId,
        tool: toolIdOfPart(part),
        state: step.state,
        summary: step.summary,
      });
    } else if (part.type === 'data-attachment') {
      const data = (part.data ?? {}) as Part;
      const filename = str(data.filename);
      if (filename)
        files.push({
          attachmentId: str(data.id) ?? str(data.attachmentId),
          filename,
          mediaType: str(data.mimeType) ?? str(data.mediaType),
        });
    } else if (part.type === 'file') {
      // Only the name and type: a file part's url can be a data: URL holding the bytes.
      const filename = str(part.filename);
      if (filename) files.push({ attachmentId: null, filename, mediaType: str(part.mediaType) });
    } else if (part.type === 'source-url') {
      const url = str(part.url);
      if (url) sources.push(url);
    }
  }
  return { text: text.join('\n\n'), toolSteps, files, sources };
}
