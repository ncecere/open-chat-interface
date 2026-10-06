import { SettingsSection } from '~/components/admin/admin-ui';
import { Field } from '~/components/ui/field';
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
    'draft' | 'setDraft' | 'showValidation' | 'validation' | 'save' | 'beginEdit'
  >;
}) {
  const { draft, setDraft, showValidation, validation, save, beginEdit } = controller;
  const maxFileBytes = bytesFromMb(draft.maxFileMb);

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
            hint={
              showValidation && validation.maxFileMb
                ? validation.maxFileMb
                : Number.isSafeInteger(maxFileBytes)
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
              aria-invalid={showValidation && Boolean(validation.maxFileMb)}
              onChange={(event) => {
                beginEdit();
                setDraft((current) => ({ ...current, maxFileMb: event.target.value }));
              }}
            />
          </Field>

          <Field
            label="Maximum files per message"
            htmlFor="max-files-per-message"
            hint={
              showValidation && validation.maxFilesPerMessage
                ? validation.maxFilesPerMessage
                : 'Maximum attachment count accepted on one message.'
            }
          >
            <Input
              id="max-files-per-message"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={draft.maxFilesPerMessage}
              disabled={save.isPending}
              aria-invalid={showValidation && Boolean(validation.maxFilesPerMessage)}
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
          hint={
            showValidation && validation.allowedMimeTypes
              ? validation.allowedMimeTypes
              : 'One MIME type per line (commas are accepted). An empty list blocks every file type.'
          }
        >
          <Textarea
            id="allowed-mime-types"
            rows={8}
            value={draft.allowedMimeTypes}
            disabled={save.isPending}
            spellCheck={false}
            aria-invalid={showValidation && Boolean(validation.allowedMimeTypes)}
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
