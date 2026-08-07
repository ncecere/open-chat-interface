import type { Persona } from '@oci/shared';
import { Check, Pencil, Plus, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { Input, Textarea } from '~/components/ui/input';
import {
  useCreatePersona,
  useDeletePersona,
  usePersonas,
  useUpdatePersona,
} from '~/hooks/use-personas';
import { cn } from '~/lib/utils';

interface PersonaPickerProps {
  selectedId: string | null;
  onSelect: (personaId: string | null) => void;
  available: boolean;
}

export function PersonaPicker({ selectedId, onSelect, available }: PersonaPickerProps) {
  const { data: personas = [] } = usePersonas(available);
  const createPersona = useCreatePersona();
  const updatePersona = useUpdatePersona();
  const deletePersona = useDeletePersona();
  const [editing, setEditing] = useState<Persona | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [traits, setTraits] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = personas.find((persona) => persona.id === selectedId) ?? null;

  useEffect(() => {
    if (selectedId && personas.length > 0 && !selected) {
      onSelect(personas.find((persona) => persona.isDefault)?.id ?? null);
    }
  }, [onSelect, personas, selected, selectedId]);

  function openEditor(persona: Persona | null) {
    setEditing(persona);
    setName(persona?.name ?? '');
    setIcon(persona?.icon ?? '');
    setSystemPrompt(persona?.systemPrompt ?? '');
    setTraits(persona?.traits.join(', ') ?? '');
    setIsDefault(persona?.isDefault ?? personas.length === 0);
    setError(null);
    setDialogOpen(true);
  }

  async function save() {
    const input = {
      name: name.trim(),
      icon: icon.trim() || null,
      systemPrompt: systemPrompt.trim(),
      traits: [
        ...new Set(
          traits
            .split(',')
            .map((trait) => trait.trim())
            .filter(Boolean),
        ),
      ],
      isDefault,
    };

    if (!input.name) {
      setError('A persona name is required.');
      return;
    }

    try {
      const result = editing
        ? await updatePersona.mutateAsync({ id: editing.id, ...input })
        : await createPersona.mutateAsync(input);
      onSelect(result.persona.id);
      setDialogOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the persona.');
    }
  }

  async function remove() {
    if (!editing) return;
    try {
      await deletePersona.mutateAsync(editing.id);
      if (selectedId === editing.id) onSelect(null);
      setDialogOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not delete the persona.');
    }
  }

  if (!available) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Choose persona"
            className={cn(
              'inline-flex h-[1.875rem] max-w-40 items-center gap-1.5 rounded-full border border-[var(--border-strong)] px-3.5',
              'text-[0.8125rem] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-control-hover)] hover:text-[var(--text-primary)]',
            )}
          >
            <UserRound className="size-4 shrink-0" />
            <span className="hidden truncate sm:inline">{selected?.name ?? 'Persona'}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="min-w-60">
          <DropdownMenuItem onSelect={() => onSelect(null)}>
            <span className="flex-1">No persona</span>
            {!selected && <Check />}
          </DropdownMenuItem>
          {personas.map((persona) => (
            <DropdownMenuItem key={persona.id} onSelect={() => onSelect(persona.id)}>
              <span aria-hidden>{persona.icon || '◦'}</span>
              <span className="min-w-0 flex-1 truncate">{persona.name}</span>
              {persona.isDefault && (
                <span className="text-[0.625rem] uppercase text-[var(--text-muted)]">Default</span>
              )}
              {selectedId === persona.id && <Check />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          {selected && (
            <DropdownMenuItem onSelect={() => openEditor(selected)}>
              <Pencil />
              Edit {selected.name}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => openEditor(null)}>
            <Plus />
            Create persona
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit persona' : 'Create persona'}</DialogTitle>
            <DialogDescription>
              Personas add focused instructions and traits to the instance system prompt.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-[5rem_1fr] gap-3">
              <label htmlFor="persona-icon" className="text-sm">
                <span className="mb-1.5 block text-[var(--text-muted)]">Icon</span>
                <Input
                  id="persona-icon"
                  value={icon}
                  maxLength={32}
                  onChange={(event) => setIcon(event.target.value)}
                />
              </label>
              <label htmlFor="persona-name" className="text-sm">
                <span className="mb-1.5 block text-[var(--text-muted)]">Name</span>
                <Input
                  id="persona-name"
                  value={name}
                  maxLength={80}
                  placeholder="Code reviewer"
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
            </div>

            <label htmlFor="persona-instructions" className="text-sm">
              <span className="mb-1.5 block text-[var(--text-muted)]">Instructions</span>
              <Textarea
                id="persona-instructions"
                rows={6}
                maxLength={12000}
                value={systemPrompt}
                placeholder="Review code carefully and explain concrete improvements..."
                onChange={(event) => setSystemPrompt(event.target.value)}
              />
            </label>

            <label htmlFor="persona-traits" className="text-sm">
              <span className="mb-1.5 block text-[var(--text-muted)]">Traits</span>
              <Input
                id="persona-traits"
                value={traits}
                placeholder="concise, pragmatic, curious"
                onChange={(event) => setTraits(event.target.value)}
              />
              <span className="mt-1 block text-xs text-[var(--text-muted)]">
                Separate up to 20 traits with commas.
              </span>
            </label>

            <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
              <input
                type="checkbox"
                checked={isDefault}
                onChange={(event) => setIsDefault(event.target.checked)}
              />
              Use by default for new chats
            </label>

            {error && <p className="text-sm text-[var(--danger-foreground)]">{error}</p>}
          </div>

          <DialogFooter className="justify-between">
            <div>
              {editing && (
                <Button variant="danger" onClick={remove} disabled={deletePersona.isPending}>
                  Delete
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="accent"
                onClick={save}
                disabled={createPersona.isPending || updatePersona.isPending}
              >
                Save persona
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
