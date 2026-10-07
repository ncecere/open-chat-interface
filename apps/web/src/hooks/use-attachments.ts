import type { Attachment } from '@oci/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useCurrentUser } from '~/hooks/use-current-user';
import { ApiError, api } from '~/lib/api-client';
import { notePolicyRequiredResponse } from '~/lib/policy-required';
import { formatLimit } from '~/lib/utils';

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
  /** Sent, or handed to the conversation that sends it: never discarded here. */
  handedOver?: boolean;
}

/** An upload that got no answer: the server was out of reach or the file unreadable. */
class UploadNotSent extends Error {
  constructor(filename: string) {
    super(
      `${filename} was not uploaded: the server could not be reached, or the file could not be read. Try again.`,
    );
  }
}

/**
 * Discards an upload the composer will not send (#297): one removed with its
 * ×, or left behind when the composer goes (New Chat, another conversation),
 * which stayed stored and counted as if sent. The server keeps a file that
 * was sent meanwhile. `keepalive`, so it outlives a page being left.
 */
function discardAttachment(id: string) {
  return api.delete(`/attachments/${id}/unsent`, { keepalive: true }).catch(() => undefined);
}

/**
 * Owns composer attachment state. Files upload immediately so the model call
 * only has to reference IDs.
 */
export function useAttachments() {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const resources = useRef(new Map<string, AttachmentResource>());
  // The instance's limits, checked before uploading: a file over them would
  // otherwise upload, count against storage, and fail only on send.
  const chat = useCurrentUser().data?.chat;
  const limits = useRef({ maxFiles: Infinity, maxBytes: Infinity });
  limits.current = {
    maxFiles: chat?.maxFilesPerMessage ?? Infinity,
    maxBytes: chat?.maxFileBytes ?? Infinity,
  };
  // Files already attached (failed ones are never sent, so they do not count),
  // read synchronously so two quick picks cannot both use the last slot.
  const attached = useRef(0);
  attached.current = items.filter((item) => item.status !== 'error').length;

  useEffect(
    () => () => {
      for (const resource of resources.current.values()) {
        resource.controller?.abort();
        if (resource.previewUrl) URL.revokeObjectURL(resource.previewUrl);
        // Left unsent: the composer is going, and the file with it (#297).
        if (resource.attachmentId && !resource.handedOver)
          void discardAttachment(resource.attachmentId);
      }
      resources.current.clear();
    },
    [],
  );

  const upload = useCallback(async (picked: File[]) => {
    if (picked.length === 0) return;

    const { maxFiles, maxBytes } = limits.current;
    const refused: PendingAttachment[] = [];
    const files: File[] = [];
    for (const file of picked) {
      const reason =
        file.size > maxBytes
          ? `${file.name} is larger than the ${formatLimit(maxBytes)} limit, so it was not uploaded.`
          : attached.current + files.length >= maxFiles
            ? `Only ${maxFiles} files can be sent with one message, so this one was not attached. Remove a file to add another.`
            : null;
      if (reason) {
        refused.push({
          localId: crypto.randomUUID(),
          filename: file.name,
          sizeBytes: file.size,
          mimeType: file.type,
          status: 'error',
          error: reason,
        });
      } else {
        files.push(file);
      }
    }
    attached.current += files.length;
    if (refused.length > 0) setItems((current) => [...current, ...refused]);
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
          // fetch itself rejects only when no answer came: the server could not
          // be reached, or the browser could not read the file. Its own text
          // ("Failed to fetch") means nothing to people (#208).
          const response = await fetch('/api/attachments', {
            method: 'POST',
            body,
            credentials: 'same-origin',
            signal: controller.signal,
          }).catch(() => {
            throw new UploadNotSent(file.name);
          });

          if (!response.ok) {
            void notePolicyRequiredResponse(response);
            const payload = (await response.json().catch(() => null)) as {
              error?: { message?: string };
            } | null;
            throw new ApiError(
              response.status,
              'UPLOAD_FAILED',
              payload?.error?.message ?? `${file.name} could not be uploaded. Try again.`,
            );
          }

          const { attachments } = (await response.json()) as { attachments: Attachment[] };
          const uploaded = attachments[0];
          if (!uploaded) throw new Error('Upload returned no attachment');

          if (resources.current.get(entry.localId) !== resource) {
            await Promise.all(attachments.map((attachment) => discardAttachment(attachment.id)));
            return;
          }

          resource.attachmentId = uploaded.id;
          // The server checks the contents; the browser only guessed from the
          // name. A text file named .png is text: no image preview (#209).
          const image = uploaded.mimeType.startsWith('image/');
          if (!image && resource.previewUrl) {
            URL.revokeObjectURL(resource.previewUrl);
            resource.previewUrl = undefined;
          }
          setItems((current) =>
            current.map((item) =>
              item.localId === entry.localId
                ? {
                    ...item,
                    status: 'ready',
                    attachment: uploaded,
                    mimeType: uploaded.mimeType,
                    previewUrl: image ? item.previewUrl : undefined,
                  }
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
                    error:
                      error instanceof ApiError || error instanceof UploadNotSent
                        ? error.message
                        : `${file.name} could not be uploaded. Try again.`,
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

    if (resource?.attachmentId) await discardAttachment(resource.attachmentId);
  }, []);

  const clear = useCallback(() => {
    for (const resource of resources.current.values()) {
      resource.controller?.abort();
      if (resource.previewUrl) URL.revokeObjectURL(resource.previewUrl);
      if (resource.attachmentId && !resource.handedOver)
        void discardAttachment(resource.attachmentId);
    }
    resources.current.clear();
    setItems([]);
  }, []);

  /**
   * These files (all, without `ids`) are being sent: the composer no longer
   * discards them when it goes (#297). Their chips stay until `consume`. A
   * send that is refused leaves them to the server's daily cleanup if they
   * are then abandoned.
   */
  const handOver = useCallback((ids?: string[]) => {
    for (const resource of resources.current.values()) {
      if (resource.attachmentId && (!ids || ids.includes(resource.attachmentId)))
        resource.handedOver = true;
    }
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
    handOver,
    readyIds,
    uploading: items.some((item) => item.status === 'uploading'),
  };
}
