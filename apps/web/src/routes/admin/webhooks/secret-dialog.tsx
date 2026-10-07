import { Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from '~/components/ui/button';
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';

export function SecretDialog({ secret, onClose }: { secret: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <DialogContent className="w-[calc(100%-2rem)] max-w-lg">
      <DialogHeader>
        <DialogTitle>Signing secret</DialogTitle>
        <DialogDescription>
          Copy it into the receiver now. It is shown only this once; rotate it if it is lost.
        </DialogDescription>
      </DialogHeader>
      <div className="flex items-center gap-2">
        <Input aria-label="Signing secret" readOnly value={secret} className="font-mono" />
        <Button
          type="button"
          variant="secondary"
          aria-label="Copy secret"
          onClick={() => {
            void navigator.clipboard?.writeText(secret).then(() => setCopied(true));
          }}
        >
          <Copy />
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <p className="text-xs text-[var(--text-muted)]">
        Verify each request: HMAC-SHA256 of <code>timestamp.body</code> with this secret must equal
        the <code>v1=</code> value in <code>OCI-Webhook-Signature</code>.
      </p>
      <DialogFooter>
        <Button type="button" variant="primary" onClick={onClose}>
          Done
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
