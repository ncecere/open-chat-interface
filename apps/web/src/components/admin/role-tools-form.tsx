import type { RoleAccess, UpdateRoleToolsInput } from '@oci/shared';
import { useMutation } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { EditOnly } from '~/components/admin/admin-access';
import { MutationError } from '~/components/admin/admin-ui';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { api } from '~/lib/api-client';

const KIND_DESCRIPTION = {
  read: 'Looks things up. Runs without asking.',
  write: 'Changes something elsewhere. Always asks the person to approve each call.',
} as const;

const TOOL_DESCRIPTIONS: Record<string, string> = {
  web_search:
    'Lets a tool-capable model search the web itself when the Search switch is on. Without it, OCI searches once before the reply.',
};

/** Only tools whose switch differs from what is saved. Exported for tests. */
export function roleToolChanges(
  saved: RoleAccess['tools'],
  draft: Record<string, boolean>,
): UpdateRoleToolsInput['tools'] {
  return Object.fromEntries(
    saved
      .filter((tool) => draft[tool.id] !== tool.allowed)
      .map((tool) => [tool.id, draft[tool.id]!]),
  );
}

/**
 * Which registered tools a role's models may call. A tool is only offered to
 * models with the tool-calling capability, and only where its own switches
 * (such as web search) are on.
 */
export function RoleToolsForm({
  access,
  roleLabel,
  onSaved,
}: {
  access: RoleAccess;
  roleLabel: string;
  onSaved: () => Promise<unknown>;
}) {
  const { role, tools } = access;
  const savedMap = () => Object.fromEntries(tools.map((tool) => [tool.id, tool.allowed]));
  const [draft, setDraft] = useState<Record<string, boolean>>(savedMap);
  const [showSaved, setShowSaved] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the saved list changes.
  useEffect(() => setDraft(savedMap()), [tools]);
  useEffect(() => {
    if (!showSaved) return;
    const timer = setTimeout(() => setShowSaved(false), 2_500);
    return () => clearTimeout(timer);
  }, [showSaved]);

  const changes = roleToolChanges(tools, draft);
  const hasChanges = Object.keys(changes).length > 0;
  const save = useMutation({
    mutationFn: () => api.put(`/admin/roles/${role}/tools`, { tools: changes }),
    onSuccess: async () => {
      setShowSaved(true);
      await onSaved();
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (hasChanges) save.mutate();
  }

  if (tools.length === 0)
    return <p className="text-[var(--text-muted)] text-sm">No tools are registered.</p>;

  return (
    <form onSubmit={submit} className="flex flex-col gap-6" noValidate>
      <p className="text-[var(--text-muted)] text-xs">
        Tools the {roleLabel} role’s models may call during a reply. Only models with the tool
        calling capability use tools; others answer as before.
      </p>
      <div className="divide-y divide-[var(--border-subtle)]">
        {tools.map((tool) => {
          const id = `role-${role}-tool-${tool.id.replace(/[^A-Za-z0-9_-]/g, '-')}`;
          return (
            <div key={tool.id} className="flex items-start justify-between gap-6 py-4 first:pt-0">
              <div className="min-w-0">
                <label htmlFor={id} className="font-medium text-sm">
                  {tool.label}
                </label>
                <p id={`${id}-description`} className="mt-1 text-[var(--text-muted)] text-xs">
                  {TOOL_DESCRIPTIONS[tool.id] ? `${TOOL_DESCRIPTIONS[tool.id]} ` : ''}
                  {KIND_DESCRIPTION[tool.kind]}
                </p>
              </div>
              <Switch
                id={id}
                className="mt-0.5"
                checked={draft[tool.id] ?? false}
                aria-describedby={`${id}-description`}
                onCheckedChange={(checked) => {
                  save.reset();
                  setShowSaved(false);
                  setDraft((current) => ({ ...current, [tool.id]: checked }));
                }}
              />
            </div>
          );
        })}
      </div>
      <EditOnly>
        <div className="flex items-center justify-end gap-3">
          <MutationError
            error={save.error}
            message={`Tools for the ${role} role could not be saved.`}
            className="mr-auto"
          />
          {showSaved && (
            <span className="flex items-center gap-1.5 text-[var(--success)] text-sm">
              <CheckCircle2 className="size-4" aria-hidden="true" />
              Saved
            </span>
          )}
          <Button type="submit" variant="primary" disabled={!hasChanges || save.isPending}>
            {save.isPending && <Spinner />}
            Save tools
          </Button>
        </div>
      </EditOnly>
    </form>
  );
}
