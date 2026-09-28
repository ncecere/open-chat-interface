import type { Attachment } from '@oci/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '~/lib/api-client';

export interface PendingAttachment {
  localId: string;
  filename: string;
  sizeBytes: number;
  mimeType: string;
  status: 'uploading' | 'ready' | 'error';
  error?: string;
  /** Object URL for local image preview while uploading. */
  previewUrl?: string;
  attachment?: Attachment;
}

interface AttachmentResource {
  controller?: AbortController;
  previewUrl?: string;
  attachmentId?: string;
}

function deleteAttachment(id: string) {
  return api.delete(`/attachments/${id}`).catch(() => undefined);
}

/**
 * Owns composer attachment state. Files upload immediately so the model call
 * only has to reference IDs.
 */
export function useAttachments() {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const resources = useRef(new Map<string, AttachmentResource>());

  useEffect(
    () => () => {
      for (const resource of resources.current.values()) {
        resource.controller?.abort();
        if (resource.previewUrl) URL.revokeObjectURL(resource.previewUrl);
      }
      resources.current.clear();
    },
    [],
  );

  const upload = useCallback(async (files: File[]) => {
    if (files.length === 0) return;

    const pending: PendingAttachment[] = files.map((file) => {
      const localId = crypto.randomUUID();
      const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
      resources.current.set(localId, { previewUrl });

      return {
        localId,
        filename: file.name,
        sizeBytes: file.size,
        mimeType: file.type,
        status: 'uploading',
        previewUrl,
      };
    });

    setItems((current) => [...current, ...pending]);

    // Upload concurrently, while handling each file's failure independently.
    await Promise.all(
      files.map(async (file, index) => {
        const entry = pending[index];
        if (!entry) return;

        const resource = resources.current.get(entry.localId);
        if (!resource) return;

        const controller = new AbortController();
        resource.controller = controller;

        const body = new FormData();
        body.append('files', file);

        try {
          const response = await fetch('/api/attachments', {
            method: 'POST',
            body,
            credentials: 'same-origin',
            signal: controller.signal,
          });

          if (!response.ok) {
            const payload = (await response.json().catch(() => null)) as {
              error?: { message?: string };
            } | null;
            throw new ApiError(
              response.status,
              'UPLOAD_FAILED',
              payload?.error?.message ?? 'Upload failed',
            );
          }

          const { attachments } = (await response.json()) as { attachments: Attachment[] };
          const uploaded = attachments[0];
          if (!uploaded) throw new Error('Upload returned no attachment');

          if (resources.current.get(entry.localId) !== resource) {
            await Promise.all(attachments.map((attachment) => deleteAttachment(attachment.id)));
            return;
          }

          resource.attachmentId = uploaded.id;
          setItems((current) =>
            current.map((item) =>
              item.localId === entry.localId
                ? { ...item, status: 'ready', attachment: uploaded }
                : item,
            ),
          );
        } catch (error) {
          if (resources.current.get(entry.localId) !== resource) return;

          setItems((current) =>
            current.map((item) =>
              item.localId === entry.localId
                ? {
                    ...item,
                    status: 'error',
                    error: error instanceof Error ? error.message : 'Upload failed',
                  }
                : item,
            ),
          );
        } finally {
          if (resources.current.get(entry.localId) === resource) {
            resource.controller = undefined;
          }
        }
      }),
    );
  }, []);

  const remove = useCallback(async (localId: string) => {
    const resource = resources.current.get(localId);
    resources.current.delete(localId);
    resource?.controller?.abort();

    if (resource?.previewUrl) URL.revokeObjectURL(resource.previewUrl);
    setItems((current) => current.filter((item) => item.localId !== localId));

    if (resource?.attachmentId) await deleteAttachment(resource.attachmentId);
  }, []);

  const clear = useCallback(() => {
    for (const resource of resources.current.values()) {
      resource.controller?.abort();
      if (resource.previewUrl) URL.revokeObjectURL(resource.previewUrl);
    }
    resources.current.clear();
    setItems([]);
  }, []);

  // Acceptance transfers only these files to saved history. Never abort another
  // upload, delete an allocated object, or clear the next turn's composer state.
  const consume = useCallback((ids: string[]) => {
    if (!ids.length) return;
    const accepted = new Set(ids);
    for (const [localId, resource] of resources.current) {
      if (!resource.attachmentId || !accepted.has(resource.attachmentId)) continue;
      if (resource.previewUrl) URL.revokeObjectURL(resource.previewUrl);
      resources.current.delete(localId);
    }
    setItems((current) => {
      const remaining = current.filter(
        (item) => !item.attachment || !accepted.has(item.attachment.id),
      );
      return remaining.length === current.length ? current : remaining;
    });
  }, []);

  const readyIds = items
    .filter((item) => item.status === 'ready' && item.attachment)
    .map((item) => item.attachment!.id);

  return {
    items,
    upload,
    remove,
    clear,
    consume,
    readyIds,
    uploading: items.some((item) => item.status === 'uploading'),
  };
}
