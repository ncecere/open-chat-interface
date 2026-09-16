import { SettingsSection } from '~/components/admin/admin-ui';
import { Field } from '~/components/ui/field';
import { Input, Textarea } from '~/components/ui/input';
import type { StorageSettingsController } from './use-storage-settings';

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KiB`;
  return `${bytes} B`;
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
  const maxFileBytes = Number(draft.maxFileBytes);

  return (
    <SettingsSection
      title="Upload policy"
      description="Limits are enforced by the attachment API for every uploaded file and message."
    >
      <div className="flex flex-col gap-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="Maximum file size (bytes)"
            htmlFor="max-file-bytes"
            hint={
              showValidation && validation.maxFileBytes
                ? validation.maxFileBytes
                : Number.isSafeInteger(maxFileBytes) && maxFileBytes > 0
                  ? `Currently ${formatBytes(maxFileBytes)} per file.`
                  : 'Enter a positive whole number.'
            }
          >
            <Input
              id="max-file-bytes"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={draft.maxFileBytes}
              disabled={save.isPending}
              aria-invalid={showValidation && Boolean(validation.maxFileBytes)}
              onChange={(event) => {
                beginEdit();
                setDraft((current) => ({ ...current, maxFileBytes: event.target.value }));
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
