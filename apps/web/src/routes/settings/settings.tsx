import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { Switch } from '~/components/ui/switch';
import { useCurrentUser } from '~/hooks/use-current-user';
import { useTheme } from '~/providers/theme-provider';

export function SettingsPage() {
  const { data } = useCurrentUser();
  const { theme, setTheme, boringMode, setBoringMode } = useTheme();

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <div className="mb-8 flex items-center justify-between">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/">
            <ArrowLeft />
            Back to Chat
          </Link>
        </Button>
      </div>

      <h1 className="text-2xl font-bold">Settings</h1>
      <p className="mt-1 text-sm text-[var(--text-muted)]">Signed in as {data?.user.email}</p>

      <div className="mt-8 flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Appearance</CardTitle>
            <CardDescription>Choose how the interface looks on this device.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <span className="text-sm">Theme</span>
              <div className="flex gap-1 rounded-lg border border-[var(--border-subtle)] p-1">
                {(['light', 'dark', 'system'] as const).map((option) => (
                  <Button
                    key={option}
                    size="sm"
                    variant={theme === option ? 'primary' : 'ghost'}
                    className="capitalize"
                    onClick={() => setTheme(option)}
                  >
                    {option}
                  </Button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm">Boring mode</p>
                <p className="text-xs text-[var(--text-muted)]">
                  Removes the accent coloring for a neutral interface.
                </p>
              </div>
              <Switch checked={boringMode} onCheckedChange={setBoringMode} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Account</CardTitle>
            <CardDescription>Your profile information.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <div className="flex justify-between">
              <span className="text-[var(--text-muted)]">Name</span>
              <span>{data?.user.name}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[var(--text-muted)]">Email</span>
              <span>{data?.user.email}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[var(--text-muted)]">Role</span>
              <span className="capitalize">{data?.user.role}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
