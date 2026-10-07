import { AlertTriangle } from 'lucide-react';
import { type ComponentProps, type ReactNode, useId, useRef, useState } from 'react';
import type { LinkSafetyModalProps } from 'streamdown';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { cn } from '~/lib/utils';

const SKIP_EXTERNAL_LINK_WARNING_KEY = 'oci.skipExternalLinkWarning';

function warningDisabled(): boolean {
  try {
    return localStorage.getItem(SKIP_EXTERNAL_LINK_WARNING_KEY) === 'true';
  } catch {
    return false;
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url, window.location.origin).host || window.location.host;
  } catch {
    return url;
  }
}

function canOpenWithoutWarning(url: string): boolean {
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.origin === window.location.origin || warningDisabled();
  } catch {
    return false;
  }
}

export function ExternalLinkWarning({ isOpen, onClose, onConfirm, url }: LinkSafetyModalProps) {
  const [remember, setRemember] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const hintId = useId();

  function continueToLink() {
    if (remember) localStorage.setItem(SKIP_EXTERNAL_LINK_WARNING_KEY, 'true');
    onConfirm();
    onClose();
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-w-2xl p-8"
        // The safe choice first, as in the app's other confirmations: Radix
        // focused the first control, the checkbox that turns the warning off
        // for good (#196).
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus();
        }}
      >
        <DialogHeader className="mb-5">
          <DialogTitle className="flex items-center gap-3 text-xl">
            <AlertTriangle className="size-5" aria-hidden="true" />
            Open external link
          </DialogTitle>
          <DialogDescription className="pt-2 text-base leading-7 text-[var(--text-secondary)]">
            We cannot guarantee the safety of external links. Be cautious and keep your personal
            information safe.
          </DialogDescription>
        </DialogHeader>

        <p className="text-base font-medium text-[var(--text-primary)]">
          Continue to: <span className="font-semibold">{safeHost(url)}</span>
        </p>

        {/* The checkbox is named by its label alone; the note under it is its
            description, not part of its name (#196). */}
        <div className="mt-5 flex items-start gap-3">
          <input
            id={`${hintId}-remember`}
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
            aria-describedby={`${hintId}-hint`}
            className="mt-1 size-4 cursor-pointer rounded border border-[var(--border-strong)] accent-[var(--accent)]"
          />
          <div>
            <label
              htmlFor={`${hintId}-remember`}
              className="block cursor-pointer text-sm font-medium text-[var(--text-primary)]"
            >
              Don&apos;t show this warning again
            </label>
            <p id={`${hintId}-hint`} className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
              External sites remain outside this instance&apos;s control. You can clear this choice
              by removing this site&apos;s local browser data.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button ref={cancelRef} type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" variant="accent" onClick={continueToLink}>
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What Streamdown puts in place of a link's address while it is still streaming. */
const INCOMPLETE_LINK = 'streamdown:incomplete-link';

/**
 * A link in a message, for Streamdown's `components.a` (#174). Streamdown's
 * own link-safety mode renders every link as an inline-block <button>: a long
 * address broke the sentence around it, screen readers heard "button", and it
 * could not be opened in a new tab or have its address copied. This is an
 * ordinary link that opens in a new tab; a click on one leaving this instance
 * still shows the external-link warning first, as before.
 */
export function MessageLink({
  href,
  children,
  className,
  node: _node,
  ...rest
}: ComponentProps<'a'> & { node?: unknown }) {
  const [open, setOpen] = useState(false);
  const linkClass = cn('wrap-anywhere font-medium text-primary underline', className);
  // Being written (or refused by the URL policy): text until it is complete.
  if (!href || href === INCOMPLETE_LINK)
    return (
      <span className={linkClass} data-streamdown="link" data-incomplete={Boolean(href)}>
        {children}
      </span>
    );
  return (
    <>
      <a
        {...rest}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={linkClass}
        data-streamdown="link"
        onClick={(event) => {
          if (canOpenWithoutWarning(href)) return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        {children}
      </a>
      <ExternalLinkWarning
        isOpen={open}
        onClose={() => setOpen(false)}
        onConfirm={() => window.open(href, '_blank', 'noopener,noreferrer')}
        url={href}
      />
    </>
  );
}

export function SafeExternalLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  function activate() {
    if (canOpenWithoutWarning(href)) {
      window.open(href, '_blank', 'noopener,noreferrer');
    } else {
      setOpen(true);
    }
  }

  return (
    <>
      <button type="button" className={className} onClick={activate}>
        {children}
      </button>
      <ExternalLinkWarning
        isOpen={open}
        onClose={() => setOpen(false)}
        onConfirm={() => window.open(href, '_blank', 'noopener,noreferrer')}
        url={href}
      />
    </>
  );
}
