import {
  type AdminClassification,
  type AdminDataClass,
  CLASSIFICATION_SERVICES,
  type ClassificationService,
} from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { SaveRow, SettingsSection } from '~/components/admin/admin-ui';
import { DataClassSelect } from '~/components/admin/data-class-select';
import { useReportUnsaved } from '~/components/admin/unsaved-changes';
import { ADMIN_CLASSIFICATION_KEY } from '~/hooks/use-admin-classification';
import { api, apiErrorMessage } from '~/lib/api-client';

type Approvals = Record<ClassificationService, string[]>;

const SERVICE_TEXT: Record<ClassificationService, { legend: string; empty: string; hint: string }> =
  {
    webSearch: {
      legend: 'Web search may receive',
      empty:
        'No class: a conversation that carries any class does not use web search (the tool is not offered and the search before a reply is skipped).',
      hint: 'The question sent to the search provider is written from the conversation.',
    },
    embeddings: {
      legend: 'Meaning-based project search may receive',
      empty:
        'No class: a conversation or project that carries any class is searched by keywords only, and its files are not sent to the embeddings provider.',
      hint: 'This covers the question and the project’s file passages.',
    },
    reranking: {
      legend: 'Reranking may receive',
      empty:
        'No class: a conversation that carries any class keeps the combined order of search results.',
      hint: 'The question and the candidate passages go to the reranking model.',
    },
  };

const same = (a: readonly string[], b: readonly string[]) =>
  [...a].sort().join() === [...b].sort().join();

/**
 * Web search, embeddings and reranking are outside services, not models, so
 * what each may receive is set here (#395). Each starts with no class.
 */
export function ServicesSection({
  settings,
  classes,
}: {
  settings: AdminClassification;
  classes: readonly AdminDataClass[];
}) {
  const queryClient = useQueryClient();
  const [approvals, setApprovals] = useState<Approvals>({ ...settings.services });
  const dirty = CLASSIFICATION_SERVICES.some(
    (name) => !same(approvals[name], settings.services[name]),
  );
  useReportUnsaved(dirty);
  const save = useMutation({
    mutationFn: () => api.patch('/admin/classification', { services: approvals }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ADMIN_CLASSIFICATION_KEY }),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (dirty) save.mutate();
  }

  return (
    <SettingsSection
      title="Other services"
      description="Web search, meaning-based project search (embeddings) and reranking are outside services, not models. Choose which classes each may receive; the default is none."
    >
      <form onSubmit={submit} noValidate className="flex max-w-2xl flex-col gap-6">
        {CLASSIFICATION_SERVICES.map((name) => (
          <DataClassSelect
            key={name}
            legend={SERVICE_TEXT[name].legend}
            classes={classes}
            value={approvals[name]}
            onChange={(ids) => {
              save.reset();
              setApprovals((current) => ({ ...current, [name]: ids }));
            }}
            emptyText={SERVICE_TEXT[name].empty}
            hint={SERVICE_TEXT[name].hint}
          />
        ))}
        <SaveRow
          hasChanges={dirty}
          isPending={save.isPending}
          errorMessage={
            save.error ? apiErrorMessage(save.error, 'The approvals could not be saved.') : null
          }
          successMessage={save.isSuccess && !dirty ? 'Approvals saved.' : null}
          subject="the other services"
        />
      </form>
    </SettingsSection>
  );
}
