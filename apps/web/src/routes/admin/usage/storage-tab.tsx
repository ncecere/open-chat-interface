import { useQuery } from '@tanstack/react-query';
import { SettingsSection } from '~/components/admin/admin-ui';
import { api } from '~/lib/api-client';
import { bytes, compact, type StorageResponse } from './usage-helpers';
import { PeopleList, StatGrid, TabPending, TruncationNote } from './usage-ui';

export function StorageTab() {
  const query = useQuery({
    queryKey: ['admin', 'usage', 'storage'],
    queryFn: () => api.get<StorageResponse>('/admin/usage/storage'),
  });
  const { data } = query;

  if (!data) return <TabPending query={query} title="Storage usage could not be loaded." />;

  return (
    <div className="flex flex-col gap-10">
      <StatGrid
        stats={[
          { label: 'In use', value: bytes(data.liveBytes) },
          { label: 'Files', value: compact(data.liveFileCount) },
          { label: 'Pending deletion', value: bytes(data.pendingBytes) },
          { label: 'In trash', value: compact(data.pendingFileCount) },
        ]}
      />

      <SettingsSection
        title="By person"
        description="Who is holding the most. Deleted files are excluded; they no longer count against anyone's allowance."
      >
        <PeopleList
          entries={data.topUsers.map((entry) => ({
            userId: entry.userId,
            name: entry.name,
            email: entry.email,
            primary: bytes(entry.bytes),
            secondary: `${compact(entry.files)} files`,
          }))}
        />
        <TruncationNote
          shown={data.topUsers.length}
          total={data.totalUsers}
          noun="people holding files"
        />
      </SettingsSection>
    </div>
  );
}
