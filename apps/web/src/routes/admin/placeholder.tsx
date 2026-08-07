import { Construction } from 'lucide-react';
import { Card, CardContent } from '~/components/ui/card';

/**
 * Shared stub for admin sections whose backend routes exist but whose UI is
 * built in a later phase.
 */
export function AdminPlaceholderPage({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div>
      <h1 className="text-2xl font-bold">{title}</h1>
      <p className="mt-1 text-sm text-[var(--text-muted)]">{description}</p>

      <Card className="mt-8">
        <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
          <Construction className="size-8 text-[var(--text-muted)]" />
          <p className="text-sm text-[var(--text-secondary)]">This section is not built yet.</p>
          <p className="max-w-md text-xs text-[var(--text-muted)]">
            The API endpoints backing this page already exist, so the interface can be added without
            further server work.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
