import { Copy, Download } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '~/components/ui/button';
import { saveBlob } from '~/lib/api-client';

/** What the downloaded file says above the codes; never an address or a name. */
const FILE_HEADER =
  'Recovery codes\nEach code works once, to sign in if you cannot use your authenticator app.\nKeep this file somewhere safe and private.\n\n';

/**
 * The recovery codes, shown once (#399).
 *
 * They are held by the caller in component state only: not in the query
 * cache, the address or storage, and the server never shows them again. So the
 * person has to say they saved them before Done works, and a dialog showing
 * them cannot be dismissed any other way (see `saved`). Copy and Download are
 * the ways to keep them; both are buttons, nothing happens by itself.
 */
export function RecoveryCodes({
  codes,
  onDone,
  onSavedChange,
  heading = 'Save your recovery codes',
}: {
  codes: string[];
  onDone: () => void;
  /** Tells a dialog around this whether it may be dismissed. */
  onSavedChange?: (saved: boolean) => void;
  heading?: string;
}) {
  const savedId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null);

  // The control that led here has gone; the heading is where reading starts.
  useEffect(() => headingRef.current?.focus(), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
  }

  function download() {
    saveBlob(
      new Blob([FILE_HEADER, codes.join('\n'), '\n'], { type: 'text/plain;charset=utf-8' }),
      'recovery-codes.txt',
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h4 ref={headingRef} tabIndex={-1} className="text-sm font-semibold outline-none">
          {heading}
        </h4>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          If you cannot use your authenticator app, each of these codes signs you in once. You will
          not be able to see these again, so keep them somewhere safe, such as a password manager.
        </p>
      </div>

      <ul
        aria-label="Recovery codes"
        className="grid grid-cols-1 gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-control)]/40 p-4 sm:grid-cols-2"
      >
        {codes.map((code) => (
          <li
            key={code}
            data-testid="recovery-code"
            className="select-all font-mono text-sm tracking-wide text-[var(--text-primary)]"
          >
            {code}
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={copy}>
          <Copy />
          Copy codes
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={download}>
          <Download />
          Download codes
        </Button>
        <p role="status" className="text-xs text-[var(--text-muted)]">
          {copied === 'copied' && 'Copied to the clipboard.'}
          {copied === 'failed' && 'Your browser would not copy them. Select them and copy by hand.'}
        </p>
      </div>

      <label
        htmlFor={savedId}
        className="flex items-center gap-2 text-sm text-[var(--text-secondary)]"
      >
        <input
          id={savedId}
          type="checkbox"
          checked={saved}
          onChange={(event) => {
            setSaved(event.target.checked);
            onSavedChange?.(event.target.checked);
          }}
          className="size-4 accent-[var(--accent)]"
        />
        I have saved my recovery codes
      </label>

      <div className="flex justify-end">
        <Button type="button" variant="accent" disabled={!saved} onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
