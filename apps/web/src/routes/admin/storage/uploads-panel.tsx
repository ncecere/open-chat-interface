import { MAX_FILES_PER_MESSAGE } from '@oci/shared';
import { SettingsSection } from '~/components/admin/admin-ui';
import { Field, invalidFieldProps } from '~/components/ui/field';
import { Input, Textarea } from '~/components/ui/input';
import { bytesFromMb, MAX_UPLOAD_MB } from './storage-draft';
import type { StorageSettingsController } from './use-storage-settings';

/** In the units Roles & access uses (1 MB = 1,024 KB), so the two pages agree. */
function formatBytes(bytes: number) {
  const short = (value: number) => String(Number(value.toFixed(2)));
  if (bytes >= 1024 * 1024 * 1024) return `${short(bytes / (1024 * 1024 * 1024))} GB`;
  if (bytes >= 1024 * 1024) return `${short(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${short(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

export function UploadsPanel({
  controller,
}: {
  controller: Pick<
    StorageSettingsController,
    'draft' | 'setDraft' | 'validation' | 'save' | 'beginEdit'
  >;
}) {
  const { draft, setDraft, validation, save, beginEdit } = controller;
  const maxFileBytes = bytesFromMb(draft.maxFileMb);

  // Each problem is shown under its field, in error colour, which is marked
  // invalid and described by it, not in place of the hint (#302).
  const fieldError = (message?: string) => message || null;

  return (
    <SettingsSection
      title="Upload policy"
      description="Limits are enforced by the attachment API for every uploaded file and message."
    >
      <div className="flex flex-col gap-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="Maximum file size (MB)"
            htmlFor="max-file-bytes"
            error={fieldError(validation.maxFileMb)}
            hint={
              Number.isSafeInteger(maxFileBytes)
                ? `Currently ${formatBytes(maxFileBytes)} per file.`
                : `Enter a number of MB, up to ${MAX_UPLOAD_MB.toLocaleString('en-US')}.`
            }
          >
            <Input
              id="max-file-bytes"
              type="number"
              inputMode="decimal"
              min={0}
              max={MAX_UPLOAD_MB}
              step="any"
              value={draft.maxFileMb}
              disabled={save.isPending}
              {...invalidFieldProps('max-file-bytes', fieldError(validation.maxFileMb))}
              onChange={(event) => {
                beginEdit();
                setDraft((current) => ({ ...current, maxFileMb: event.target.value }));
              }}
            />
          </Field>

          <Field
            label="Maximum files per message"
            htmlFor="max-files-per-message"
            error={fieldError(validation.maxFilesPerMessage)}
            hint={`Maximum attachment count accepted on one message, up to ${MAX_FILES_PER_MESSAGE}.`}
          >
            <Input
              id="max-files-per-message"
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_FILES_PER_MESSAGE}
              step={1}
              value={draft.maxFilesPerMessage}
              disabled={save.isPending}
              {...invalidFieldProps(
                'max-files-per-message',
                fieldError(validation.maxFilesPerMessage),
              )}
              onChange={(event) => {
                beginEdit();
                setDraft((current) => ({
                  ...current,
                  maxFilesPerMessage: event.target.value,
                }));
              }}
            />
          </Field>
        </div>

        <Field
          label="Allowed MIME types"
          htmlFor="allowed-mime-types"
          error={fieldError(validation.allowedMimeTypes)}
          hint={
            'One MIME type per line (commas are accepted). An empty list blocks every file type.'
          }
        >
          <Textarea
            id="allowed-mime-types"
            rows={8}
            value={draft.allowedMimeTypes}
            disabled={save.isPending}
            spellCheck={false}
            {...invalidFieldProps('allowed-mime-types', fieldError(validation.allowedMimeTypes))}
            placeholder={'image/png\napplication/pdf\ntext/plain'}
            onChange={(event) => {
              beginEdit();
              setDraft((current) => ({ ...current, allowedMimeTypes: event.target.value }));
            }}
          />
        </Field>
      </div>
    </SettingsSection>
  );
}
