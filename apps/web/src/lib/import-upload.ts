import type { ApiErrorBody, ConversationImportSummary } from '@oci/shared';
import { ApiError } from './api-client';

/**
 * Uploads a ChatGPT or Claude export for import.
 *
 * XMLHttpRequest rather than fetch because only it reports upload progress,
 * and an export can be hundreds of megabytes.
 */
export function uploadImportFile(
  file: File,
  onProgress: (fraction: number) => void,
): Promise<ConversationImportSummary> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/me/imports');
    request.withCredentials = true;
    request.responseType = 'json';

    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    request.onload = () => {
      const body = request.response as
        | ({ import?: ConversationImportSummary } & Partial<ApiErrorBody>)
        | null;
      if (request.status >= 200 && request.status < 300 && body?.import) {
        onProgress(1);
        resolve(body.import);
        return;
      }
      reject(
        new ApiError(
          request.status,
          body?.error?.code ?? 'INTERNAL_ERROR',
          body?.error?.message ??
            (request.status === 413 ? 'The file is too large to import.' : 'The upload failed.'),
        ),
      );
    };
    request.onerror = () => reject(new Error('The upload was interrupted.'));
    request.onabort = () => reject(new Error('The upload was cancelled.'));

    const form = new FormData();
    form.append('file', file);
    request.send(form);
  });
}
