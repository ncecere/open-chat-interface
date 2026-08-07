import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { Field } from '~/components/ui/field';
import { Input, Textarea } from '~/components/ui/input';
import { Switch } from '~/components/ui/switch';
import { useCurrentUser } from '~/hooks/use-current-user';
import { api } from '~/lib/api-client';
import { useTheme } from '~/providers/theme-provider';

export function SettingsPage() {
  const { data } = useCurrentUser();
  const { theme, setTheme, boringMode, setBoringMode } = useTheme();
  const queryClient = useQueryClient();

  const [displayName, setDisplayName] = useState(data?.preferences.displayName ?? '');
  const [occupation, setOccupation] = useState(data?.preferences.occupation ?? '');
  const [context, setContext] = useState(data?.preferences.additionalContext ?? '');
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patch('/me/preferences', patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['me'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <div className="mb-8">
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
            <CardDescription>How the interface looks on this device.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <span className="text-sm">Theme</span>
              <div className="flex gap-1 rounded-lg border border-[var(--border-subtle)] p-1">
                {(['light', 'dark', 'system'] as const).map((option) => (
                  <Button
                    key={option}
                    size="sm"
                    variant={theme === option ? 'accent' : 'ghost'}
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
            <CardTitle>Customization</CardTitle>
            <CardDescription>
              Included with every conversation so responses match your context.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Field label="What should the assistant call you?" htmlFor="displayName">
              <Input
                id="displayName"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder={data?.user.name}
              />
            </Field>

            <Field label="What do you do?" htmlFor="occupation">
              <Input
                id="occupation"
                value={occupation}
                onChange={(event) => setOccupation(event.target.value)}
                placeholder="Engineer, student, researcher..."
              />
            </Field>

            <Field label="Anything else it should know?" htmlFor="context">
              <Textarea
                id="context"
                rows={4}
                value={context}
                onChange={(event) => setContext(event.target.value)}
                placeholder="Interests, values, or preferences to keep in mind."
              />
            </Field>

            <div className="flex items-center gap-3">
              <Button
                variant="primary"
                disabled={save.isPending}
                onClick={() =>
                  save.mutate({
                    displayName: displayName.trim() || null,
                    occupation: occupation.trim() || null,
                    additionalContext: context.trim() || null,
                  })
                }
              >
                Save preferences
              </Button>
              {saved && <span className="text-xs text-[var(--success)]">Saved</span>}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Account</CardTitle>
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
