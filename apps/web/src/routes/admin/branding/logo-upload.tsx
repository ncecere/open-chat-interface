import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { Spinner } from '~/components/ui/spinner';
import { useClearReadOnlyRefusal } from '~/lib/read-only-refusals';

/**
 * Uploads a logo file rather than requiring one to be hosted elsewhere.
 *
 * The file is stored by the instance, so branding does not break when an
 * external host changes or disappears. Saving is immediate: an upload is not a
 * draft edit, and pairing it with the surrounding form's save button would
 * suggest it could be reverted by discarding changes.
 */
export function LogoUpload({ currentLogoUrl }: { currentLogoUrl: string | null }) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  // A read-only refusal goes once changes are accepted again (#308).
  useClearReadOnlyRefusal(error, () => setError(null));

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const body = new FormData();
      body.append('file', file);
      const response = await fetch('/api/admin/settings/logo', {
        method: 'POST',
        credentials: 'same-origin',
        body,
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(payload?.error?.message ?? 'The logo could not be uploaded.');
      }
    },
    onSuccess: async () => {
      setError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] }),
        queryClient.invalidateQueries({ queryKey: ['auth', 'status'] }),
      ]);
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : 'Upload failed.'),
  });

  return (
    <Field
      label="Logo file"
      hintId="logo-file-hint"
      hint="PNG, JPEG, or WebP up to 1 MB. Shown in place of the Open Chat Interface mark and name, and used as the browser tab icon."
    >
      <div className="flex flex-wrap items-center gap-3">
        {currentLogoUrl && (
          <img
            src={currentLogoUrl}
            alt="Current logo"
            className="h-10 w-auto max-w-40 rounded border border-[var(--border-subtle)] bg-[var(--bg-control)] object-contain p-1"
          />
        )}
        {/* Opened by the button below, which is what keyboard users reach;
            named for assistive technology, and out of the Tab order so it is
            not a second, unexplained stop beside the button. */}
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          aria-label="Logo image file (PNG, JPEG or WebP)"
          tabIndex={-1}
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) upload.mutate(file);
            // Clear so choosing the same file twice still fires a change.
            event.target.value = '';
          }}
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={upload.isPending}
          // The formats and size it takes, read with it (#295).
          aria-describedby="logo-file-hint"
          onClick={() => inputRef.current?.click()}
        >
          {upload.isPending && <Spinner />}
          {currentLogoUrl ? 'Replace logo' : 'Upload logo'}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
    </Field>
  );
}
