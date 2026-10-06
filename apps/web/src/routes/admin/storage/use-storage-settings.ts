import type { InstanceSettings } from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useReportUnsaved } from '~/components/admin/unsaved-changes';
import { problemsAt, problemsElsewhere, useFieldProblems } from '~/hooks/use-clear-on-edit';
import { api, apiErrorMessage, apiErrorProblems } from '~/lib/api-client';
import { useClearReadOnlyRefusal } from '~/lib/read-only-refusals';
import {
  type CredentialAction,
  changedStorageSettings,
  type HealthMode,
  makeDraft,
  type StoragePatch,
  type StorageSettings,
  type StorageValidation,
  validateDraft,
} from './storage-draft';

/** The fields that show their own errors; any other is shown beside Save (#302). */
const STORAGE_FIELDS: Array<keyof StorageValidation> = [
  'maxFileMb',
  'maxFilesPerMessage',
  'allowedMimeTypes',
  'bucket',
  'region',
  'endpoint',
  'accessKeyId',
  'secretAccessKey',
];

/** The page's names for the fields, so a refusal names the one it is about (#127). */
const STORAGE_LABELS = {
  maxFileBytes: 'Maximum file size',
  maxFilesPerMessage: 'Maximum files per message',
  allowedMimeTypes: 'Allowed MIME types',
  bucket: 'Bucket',
  region: 'Region',
  endpoint: 'Endpoint',
  accessKeyId: 'Access key ID',
  secretAccessKey: 'Secret access key',
};

export function useStorageSettings(initialSettings: StorageSettings) {
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState(initialSettings);
  const [draft, setDraft] = useState(() => makeDraft(initialSettings));
  const [credentialAction, setCredentialAction] = useState<CredentialAction>('keep');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [showValidation, setShowValidation] = useState(false);
  const [showDriverConfirmation, setShowDriverConfirmation] = useState(false);
  const [successMessage, setSuccessMessage] = useState(false);
  // A failed connection test (not a save) is said beside Save.
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // A read-only refusal goes once changes are accepted again (#308).
  useClearReadOnlyRefusal(errorMessage, () => setErrorMessage(null));
  const [healthMessage, setHealthMessage] = useState<string | null>(null);
  // A refused save's problems, each at the field the API names (its size in
  // bytes is the form's size in MB), gone once that field is edited (#283,
  // #317's sweep); one about no field beside Save.
  const form = useRef<HTMLFormElement>(null);
  const [serverProblems, setServerProblems] = useFieldProblems(
    { ...draft, secretAccessKey: [credentialAction, secretAccessKey] },
    form,
  );

  const clientValidation = validateDraft(
    draft,
    saved.s3.hasCredential,
    credentialAction,
    secretAccessKey,
  );
  const isValid = Object.keys(clientValidation).length === 0;
  // What each field shows: the form's own check once Save was pressed, else the API's refusal.
  const validation: StorageValidation = Object.fromEntries(
    STORAGE_FIELDS.flatMap((key) => {
      const error = (showValidation && clientValidation[key]) || problemsAt(serverProblems, key);
      return error ? [[key, error]] : [];
    }),
  );
  const patch = changedStorageSettings(saved, draft, credentialAction, secretAccessKey);
  const hasChanges = Object.keys(patch).length > 0;
  useReportUnsaved(hasChanges);
  const driverChanged = saved.driver !== draft.driver;

  const save = useMutation({
    mutationFn: (storage: StoragePatch) =>
      api.patch<{ ok: boolean }>('/admin/settings', { storage }),
    onSuccess: (_response, changes) => {
      const { s3: s3Changes, ...topLevelChanges } = changes;
      const { secretAccessKey: credential, ...publicS3Changes } = s3Changes ?? {};
      const next: StorageSettings = {
        ...saved,
        ...topLevelChanges,
        s3: {
          ...saved.s3,
          ...publicS3Changes,
          hasCredential:
            credential === null
              ? false
              : typeof credential === 'string' && credential.length > 0
                ? true
                : saved.s3.hasCredential,
        },
      };
      setSaved(next);
      setDraft(makeDraft(next));
      setCredentialAction('keep');
      setSecretAccessKey('');
      setShowValidation(false);
      setShowDriverConfirmation(false);
      setErrorMessage(null);
      setServerProblems([]);
      setHealthMessage(null);
      setSuccessMessage(true);
      queryClient.setQueryData<InstanceSettings>(['admin', 'settings'], (current) =>
        current ? { ...current, storage: next } : current,
      );
    },
    onError: (error) => {
      setShowDriverConfirmation(false);
      setSuccessMessage(false);
      setServerProblems(
        apiErrorProblems(error, 'Unable to save storage settings.', STORAGE_LABELS).map(
          (problem) =>
            problem.fields[0] === 'maxFileBytes' ? { ...problem, fields: ['maxFileMb'] } : problem,
        ),
      );
    },
  });

  const health = useMutation({
    mutationFn: (mode: HealthMode) =>
      api.post<{ ok: boolean; mode: HealthMode }>('/admin/settings/storage/test', { mode }),
    onSuccess: (_response, mode) => {
      setErrorMessage(null);
      setHealthMessage(
        mode === 'write'
          ? 'S3 put, read, and delete test succeeded.'
          : 'S3 bucket access check succeeded.',
      );
    },
    onError: (error) => {
      setHealthMessage(null);
      setErrorMessage(apiErrorMessage(error, 'S3 connection test failed.'));
    },
  });

  function beginEdit() {
    setSuccessMessage(false);
    setHealthMessage(null);
    setErrorMessage(null);
  }

  function submitChanges() {
    setShowValidation(true);
    setServerProblems([]);
    if (!isValid || !hasChanges) return;
    if (driverChanged) {
      setShowDriverConfirmation(true);
      return;
    }
    save.mutate(patch);
  }

  return {
    saved,
    draft,
    setDraft,
    credentialAction,
    setCredentialAction,
    secretAccessKey,
    setSecretAccessKey,
    showValidation,
    showDriverConfirmation,
    setShowDriverConfirmation,
    successMessage,
    // A refusal about no field, or a failed connection test.
    errorMessage: problemsElsewhere(serverProblems, STORAGE_FIELDS) ?? errorMessage,
    form,
    healthMessage,
    validation,
    patch,
    hasChanges,
    driverChanged,
    save,
    health,
    beginEdit,
    submitChanges,
  };
}

export type StorageSettingsController = ReturnType<typeof useStorageSettings>;
