import { useState } from 'react';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { useCurrentUser } from '~/hooks/use-current-user';

function Section({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <h2 className="text-xl font-bold">{title}</h2>
      <div className="mt-4 flex flex-col gap-6">{children}</div>
    </section>
  );
}

function Row({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-sm font-medium text-[var(--text-primary)]">{label}</p>
      <p className="mt-1 text-sm text-[var(--text-muted)]">{description}</p>
      <div className="mt-3">{children}</div>
    </div>
  );
}

export function SettingsAccountPage() {
  const { data } = useCurrentUser();
  const [changingEmail, setChangingEmail] = useState(false);
  const [newEmail, setNewEmail] = useState('');

  return (
    <div>
      <h1 className="text-2xl font-bold">Account</h1>
      <p className="mt-1 text-sm text-[var(--text-muted)]">
        Your identity and access on this instance.
      </p>

      <Section title="Profile" className="mt-8">
        <div className="flex flex-col gap-3 text-sm">
          <div className="flex justify-between border-b border-[var(--border-subtle)] pb-3">
            <span className="text-[var(--text-muted)]">Name</span>
            <span className="text-[var(--text-primary)]">{data?.user.name}</span>
          </div>
          <div className="flex justify-between border-b border-[var(--border-subtle)] pb-3">
            <span className="text-[var(--text-muted)]">Email</span>
            <span className="text-[var(--text-primary)]">{data?.user.email}</span>
          </div>
          <div className="flex justify-between border-b border-[var(--border-subtle)] pb-3">
            <span className="text-[var(--text-muted)]">Role</span>
            <span className="capitalize text-[var(--text-primary)]">{data?.user.role}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--text-muted)]">Email verified</span>
            <span className="text-[var(--text-primary)]">
              {data?.user.emailVerified ? 'Yes' : 'No'}
            </span>
          </div>
        </div>
      </Section>

      <Section title="Security &amp; Access" className="mt-12">
        <Row
          label="Account Email"
          description="Change the email address associated with your account."
        >
          {changingEmail ? (
            <div className="flex max-w-md gap-2">
              <Input
                type="email"
                value={newEmail}
                onChange={(event) => setNewEmail(event.target.value)}
                placeholder="new@example.com"
              />
              <Button variant="accent" size="sm">
                Send link
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setChangingEmail(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button variant="secondary" size="sm" onClick={() => setChangingEmail(true)}>
              Change Email
            </Button>
          )}
        </Row>

        <Row label="Password" description="Change the password used to sign in to this account.">
          <Button variant="secondary" size="sm">
            Change Password
          </Button>
        </Row>

        <Row
          label="Devices"
          description="Manage and sign out from other devices currently logged in to your account."
        >
          <Button variant="secondary" size="sm">
            View Devices
          </Button>
        </Row>
      </Section>

      <section className="mt-12 rounded-xl border border-[var(--danger)]/40 p-6">
        <h2 className="text-xl font-bold">Danger Zone</h2>
        <p className="mt-2 text-sm text-[var(--text-muted)]">
          Permanently delete your account and all associated data.
        </p>
        <Button variant="danger" size="sm" className="mt-4">
          Delete Account
        </Button>
      </section>
    </div>
  );
}
