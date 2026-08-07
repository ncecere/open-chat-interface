import { Paperclip } from 'lucide-react';

const SHORTCUT_GROUPS = [
  {
    title: 'Navigation',
    shortcuts: [
      { label: 'Search threads', keys: ['⌘', 'K'] },
      { label: 'New chat', keys: ['⌘', '⇧', 'O'] },
      { label: 'Toggle sidebar', keys: ['⌘', 'B'] },
    ],
  },
  {
    title: 'Composer',
    shortcuts: [
      { label: 'Send message', keys: ['Enter'] },
      { label: 'New line', keys: ['⇧', 'Enter'] },
      { label: 'Open model picker', keys: ['⌘', '/'] },
    ],
  },
];

export function SettingsAttachmentsPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold">Attachments</h1>
      <p className="mt-1 text-sm text-[var(--text-muted)]">
        Manage files you have uploaded. Deleting a file removes it from the threads that use it.
      </p>

      <div className="mt-10 flex flex-col items-center gap-3 py-16 text-center">
        <Paperclip className="size-8 text-[var(--text-muted)]" />
        <p className="text-sm text-[var(--text-secondary)]">No attachments yet.</p>
        <p className="max-w-md text-xs text-[var(--text-muted)]">
          File uploads are not enabled on this instance yet.
        </p>
      </div>
    </div>
  );
}

export function SettingsShortcutsPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold">Keyboard Shortcuts</h1>
      <p className="mt-1 text-sm text-[var(--text-muted)]">
        Shortcuts available throughout the application.
      </p>

      {SHORTCUT_GROUPS.map((group) => (
        <section key={group.title} className="mt-10">
          <h2 className="text-xl font-bold">{group.title}</h2>
          <div className="mt-4 flex flex-col">
            {group.shortcuts.map((shortcut) => (
              <div
                key={shortcut.label}
                className="flex items-center justify-between border-b border-[var(--border-subtle)] py-3 last:border-0"
              >
                <span className="text-sm text-[var(--text-secondary)]">{shortcut.label}</span>
                <span className="flex gap-1">
                  {shortcut.keys.map((key) => (
                    <kbd
                      key={key}
                      className="rounded bg-[var(--bg-control-hover)] px-2 py-1 text-xs text-[var(--text-secondary)]"
                    >
                      {key}
                    </kbd>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function SettingsContactPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold">Contact Us</h1>
      <p className="mt-1 text-sm text-[var(--text-muted)]">
        This is a self-hosted instance of Open Chat Interface.
      </p>

      <div className="mt-8 flex flex-col gap-6 text-sm">
        <div>
          <p className="font-medium text-[var(--text-primary)]">Need help with your account?</p>
          <p className="mt-1 text-[var(--text-muted)]">
            Contact the administrator who runs this instance. They can reset passwords, adjust your
            role, and enable additional models.
          </p>
        </div>

        <div>
          <p className="font-medium text-[var(--text-primary)]">Found a bug?</p>
          <p className="mt-1 text-[var(--text-muted)]">
            Report issues on the project repository so they can be tracked and fixed.
          </p>
        </div>
      </div>
    </div>
  );
}
