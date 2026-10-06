import type { InstanceSettings } from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useReportUnsaved } from '~/components/admin/unsaved-changes';
import { api, apiErrorMessage } from '~/lib/api-client';
import { useClearReadOnlyRefusal } from '~/lib/read-only-refusals';
import {
  type CredentialAction,
  changedStorageSettings,
  type HealthMode,
  makeDraft,
  type StoragePatch,
  type StorageSettings,
  validateDraft,
} from './storage-draft';

export function useStorageSettings(initialSettings: StorageSettings) {
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState(initialSettings);
  const [draft, setDraft] = useState(() => makeDraft(initialSettings));
  const [credentialAction, setCredentialAction] = useState<CredentialAction>('keep');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [showValidation, setShowValidation] = useState(false);
  const [showDriverConfirmation, setShowDriverConfirmation] = useState(false);
  const [successMessage, setSuccessMessage] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // A read-only refusal goes once changes are accepted again (#308).
  useClearReadOnlyRefusal(errorMessage, () => setErrorMessage(null));
  const [healthMessage, setHealthMessage] = useState<string | null>(null);

  const validation = validateDraft(
    draft,
    saved.s3.hasCredential,
    credentialAction,
    secretAccessKey,
  );
  const isValid = Object.keys(validation).length === 0;
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
      setHealthMessage(null);
      setSuccessMessage(true);
      queryClient.setQueryData<InstanceSettings>(['admin', 'settings'], (current) =>
        current ? { ...current, storage: next } : current,
      );
    },
    onError: (error) => {
      setShowDriverConfirmation(false);
      setSuccessMessage(false);
      setErrorMessage(apiErrorMessage(error, 'Unable to save storage settings.'));
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
    errorMessage,
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
