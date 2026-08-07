import { AlertTriangle } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import type { LinkSafetyConfig, LinkSafetyModalProps } from 'streamdown';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';

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

  function continueToLink() {
    if (remember) localStorage.setItem(SKIP_EXTERNAL_LINK_WARNING_KEY, 'true');
    onConfirm();
    onClose();
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl p-8">
        <DialogHeader className="mb-5">
          <DialogTitle className="flex items-center gap-3 text-xl">
            <AlertTriangle className="size-5" aria-hidden="true" />
            Open External Link
          </DialogTitle>
          <DialogDescription className="pt-2 text-base leading-7 text-[var(--text-secondary)]">
            We cannot guarantee the safety of external links. Be cautious and keep your personal
            information safe.
          </DialogDescription>
        </DialogHeader>

        <p className="text-base font-medium text-[var(--text-primary)]">
          Continue to: <span className="font-semibold">{safeHost(url)}</span>
        </p>

        <label className="mt-5 flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
            className="mt-1 size-4 rounded border border-[var(--border-strong)] accent-[var(--accent)]"
          />
          <span>
            <span className="block text-sm font-medium text-[var(--text-primary)]">
              Don&apos;t show this warning again
            </span>
            <span className="mt-1 block text-xs leading-5 text-[var(--text-muted)]">
              External sites remain outside this instance&apos;s control. You can clear this choice
              by removing this site&apos;s local browser data.
            </span>
          </span>
        </label>

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>
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

export const MARKDOWN_LINK_SAFETY: LinkSafetyConfig = {
  enabled: true,
  onLinkCheck: canOpenWithoutWarning,
  renderModal: (props) => <ExternalLinkWarning {...props} />,
};

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
