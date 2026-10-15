import type { CatalogModel, ClassificationResponse, DataClassBlockedDetails } from '@oci/shared';
import { AlertTriangle, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { Button } from '~/components/ui/button';
import { isClassifying, listNames } from '~/lib/classification';
import { cn } from '~/lib/utils';

/**
 * Above the message box: what the conversation's data classes mean for the
 * model chosen now (#395). In `block` a model that is not approved says so
 * before anything is typed; in `warn` the send goes ahead and this says what
 * the administrator will be told. Nothing is shown when the model is fine, or
 * while classification is off. The server decides; this only reports.
 */
export function ComposerClassificationNote({
  classification,
  selectedModel,
}: {
  classification: ClassificationResponse | null | undefined;
  selectedModel: CatalogModel | null;
}) {
  if (!isClassifying(classification) || !selectedModel) return null;
  const status = classification.models.find((model) => model.slug === selectedModel.slug);
  if (!status || status.status === 'ok') return null;
  const names = listNames(status.missing.map((entry) => entry.name));
  const approved = classification.models.some((model) => model.status === 'ok');
  const blocked = status.status === 'blocked';
  return (
    <p
      role="status"
      data-classification-composer-note={status.status}
      className={cn(
        'mb-2 flex items-start gap-2 rounded-xl border px-3 py-2 text-xs leading-relaxed',
        blocked
          ? 'border-[var(--border-strong)] bg-[var(--bg-control)] text-[var(--text-secondary)]'
          : 'border-[var(--warning)]/40 bg-[var(--warning)]/10 text-[var(--text-secondary)]',
      )}
    >
      {blocked ? (
        <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      ) : (
        <AlertTriangle
          className="mt-0.5 size-4 shrink-0 text-[var(--warning)]"
          aria-hidden="true"
        />
      )}
      <span className="min-w-0">
        {blocked
          ? `${selectedModel.displayName} is not approved for ${names}, which this conversation carries. ${
              approved
                ? 'Choose a model that is approved for it before you send.'
                : 'No model is approved for it yet. Ask an administrator.'
            }`
          : `${selectedModel.displayName} is not approved for ${names}, which this conversation carries. Your message will still be sent, and the administrator will see this in the audit log.`}
      </span>
    </p>
  );
}

/**
 * A refused send (403 `DATA_CLASS_BLOCKED`): the server's own sentence, which
 * is complete, and the models that are approved as buttons. The text is back
 * in the message box; choosing a model lets the person send it again.
 */
export function BlockedSendNotice({
  message,
  details,
  models,
  onChoose,
}: {
  message: string;
  details: DataClassBlockedDetails;
  models: readonly CatalogModel[];
  onChoose: (model: CatalogModel) => void;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  // Only a refused send can be put right by another model: an approval
  // continues the reply's own model, and a summary or a link has none to pick.
  const choices =
    details.point === 'send'
      ? details.approvedModels.flatMap((approved) => {
          const model = models.find((candidate) => candidate.slug === approved.slug);
          return model ? [model] : [];
        })
      : [];
  return (
    <div
      role="alert"
      data-classification-blocked={details.point}
      className="rounded-xl bg-[var(--danger)]/15 px-4 py-3 text-sm text-[var(--danger-on-tint)]"
    >
      <p>{message}</p>
      {choices.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-xs">Approved models:</span>
          {choices.map((model) => (
            <Button
              key={model.slug}
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                onChoose(model);
                setChosen(model.displayName);
              }}
            >
              Use {model.displayName}
            </Button>
          ))}
        </div>
      )}
      {chosen && (
        <p role="status" className="mt-2 text-xs">
          Switched to {chosen}. Your message is back in the box: send it again.
        </p>
      )}
    </div>
  );
}
