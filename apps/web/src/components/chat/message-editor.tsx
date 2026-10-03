import { X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '~/components/ui/button';
import { isSendKey } from '~/lib/send-keys';

/** Draft and submission state stay inside the one message being edited. */
export function MessageEditor({
  messageId,
  initialText,
  onEdit,
  onClose,
}: {
  messageId: string;
  initialText: string;
  onEdit: (messageId: string, text: string) => Promise<void>;
  onClose: () => void;
}) {
  const [text, setText] = useState(initialText);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function cancel() {
    if (!saving) onClose();
  }

  async function save() {
    const content = text.trim();
    if (!content || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onEdit(messageId, content);
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not branch this message.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="w-full max-w-[85%] rounded-2xl border border-[var(--accent)]/60 bg-[var(--bg-user-message)] p-3">
      <textarea
        aria-label="Edit message text"
        value={text}
        disabled={saving}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') cancel();
          // Cmd/Ctrl+Enter submits and Enter adds a line whatever the "Invert
          // Send/New Line Behavior" setting: with it on that is the composer's
          // rule too, and off this larger edit box keeps its own, as before.
          // Enter confirming an IME candidate never submits.
          if (isSendKey(event, { invert: true })) {
            event.preventDefault();
            void save();
          }
        }}
        className="min-h-24 w-full resize-y bg-transparent px-1 text-[0.9375rem] leading-relaxed text-[var(--text-primary)] outline-none disabled:opacity-60"
      />
      {error && <p className="px-1 pb-2 text-xs text-[var(--danger-foreground)]">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={saving} onClick={cancel}>
          <X />
          Cancel
        </Button>
        <Button size="sm" disabled={saving || !text.trim()} onClick={() => void save()}>
          {saving ? 'Branching...' : 'Save & submit'}
        </Button>
      </div>
    </div>
  );
}
