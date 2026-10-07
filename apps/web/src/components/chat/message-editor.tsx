import { FileText, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { type AttachmentCard, isRemovedFile } from '~/components/chat/message-attachments';
import { Button } from '~/components/ui/button';
import { focusComposerSoon } from '~/lib/focus-after-navigation';
import { focusAtEnd, keepFocusWhenRemoved, rememberPlace } from '~/lib/focus-return';
import { useClearReadOnlyRefusal } from '~/lib/read-only-refusals';
import { isSendKey } from '~/lib/send-keys';

/**
 * Branches from an edited question: its new text and the ids of the files it
 * keeps (#296).
 */
export type EditMessage = (
  messageId: string,
  text: string,
  attachmentIds: string[],
) => Promise<void>;

/** Draft and submission state stay inside the one message being edited. */
export function MessageEditor({
  messageId,
  initialText,
  attachments = [],
  onEdit,
  onClose,
}: {
  messageId: string;
  initialText: string;
  /** The files the question was sent with; the edited question keeps them (#296). */
  attachments?: AttachmentCard[];
  onEdit: EditMessage;
  onClose: () => void;
}) {
  const [text, setText] = useState(initialText);
  const [error, setError] = useState<string | null>(null);
  // A read-only refusal goes once changes are accepted again (#308).
  useClearReadOnlyRefusal(error, () => setError(null));
  const [saving, setSaving] = useState(false);
  // The question's files, less any removed here; the edit is answered with them.
  const [kept, setKept] = useState(attachments);
  const textBox = useRef<HTMLTextAreaElement>(null);

  // Edit swaps the message for this box, removing the button that had focus,
  // which fell to the page: the cursor goes into the text, at its end, as
  // Edit name and Memory's Edit do (#333, #270, #291). Closing returns focus
  // to the message's Edit button (see MessageRow).
  useLayoutEffect(() => focusAtEnd(textBox.current), []);

  // Escape cancels from anywhere in the box (a file's ×, Cancel), not only
  // the text, where focus used to be the one place it worked (#333). A native
  // listener: the box is no widget of its own to hang a key handler on.
  const box = useRef<HTMLDivElement>(null);
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  useEffect(() => {
    const element = box.current;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      cancelRef.current();
    };
    element?.addEventListener('keydown', onKey);
    return () => element?.removeEventListener('keydown', onKey);
  }, []);

  function cancel() {
    if (!saving) onClose();
  }

  async function save() {
    const content = text.trim();
    if (!content || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onEdit(
        messageId,
        content,
        kept.map((file) => file.id),
      );
      // The edit became a new conversation: its message box is the place to
      // carry on, as after New chat (#333). Where there is none (a phone, which
      // would open its keyboard) focus returns to the Edit button on close.
      focusComposerSoon();
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not branch this message.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      ref={box}
      className="w-full max-w-[85%] rounded-2xl border border-[var(--accent)]/60 bg-[var(--bg-user-message)] p-3"
    >
      <textarea
        ref={textBox}
        aria-label="Edit message text"
        dir="auto"
        value={text}
        // Read-only, not disabled, while saving: a disabled box would take focus
        // with it (#333, #269).
        readOnly={saving}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // Cmd/Ctrl+Enter submits and Enter adds a line whatever the "Invert
          // Send/New Line Behavior" setting: with it on that is the composer's
          // rule too, and off this larger edit box keeps its own, as before.
          // Enter confirming an IME candidate never submits.
          if (isSendKey(event, { invert: true })) {
            event.preventDefault();
            void save();
          }
        }}
        className="min-h-24 w-full resize-y bg-transparent px-1 text-[0.9375rem] leading-relaxed text-[var(--text-primary)] outline-none read-only:opacity-60"
      />
      {/* The files go with the edited question, as with a fork or Retry; one
        removed here is left out of it (#296). */}
      {kept.length > 0 && (
        <ul aria-label="Attached files" className="mb-2 flex flex-wrap gap-2 px-1">
          {kept.map((file) => (
            <li
              key={file.id}
              data-focus-row
              title={file.filename}
              className="flex items-center gap-2 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-control-alt)] px-2 py-1.5"
            >
              <FileText className="size-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
              <span className="max-w-40 truncate text-xs text-[var(--text-secondary)]">
                {file.filename}
              </span>
              {isRemovedFile(file) && (
                <span className="text-xs text-[var(--text-muted)]">(no longer available)</span>
              )}
              <button
                type="button"
                disabled={saving}
                aria-label={`Remove ${file.filename}`}
                onClick={(event) => {
                  // The chip goes with its ×: focus moves to the next chip's
                  // ×, else the one before, else the text box (#250).
                  const chip = event.currentTarget.closest<HTMLElement>('[data-focus-row]');
                  if (chip) {
                    keepFocusWhenRemoved(chip, {
                      ...rememberPlace(event.currentTarget),
                      fallback: textBox.current,
                    });
                  }
                  setKept((current) => current.filter((entry) => entry.id !== file.id));
                }}
                className="rounded p-0.5 text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] disabled:opacity-60"
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {kept.length < attachments.length && (
        <p className="px-1 pb-2 text-xs text-[var(--text-muted)]">
          Removed files are left out of the edited message. Cancel to keep them.
        </p>
      )}
      {error && <p className="px-1 pb-2 text-xs text-[var(--danger-on-tint)]">{error}</p>}
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
