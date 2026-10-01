import type { AuditLogEntry } from '@oci/shared';
import { Fragment } from 'react';
import { Badge } from '~/components/ui/badge';
import {
  actorLabel,
  DetailsButton,
  EventDetails,
  formatTimestamp,
  TargetCell,
  targetLabel,
} from './event-details';

export function DesktopEventTable({
  entries,
  expandedIds,
  onToggle,
}: {
  entries: AuditLogEntry[];
  expandedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="relative hidden overflow-x-auto md:block">
      <table className="w-full min-w-[48rem] table-fixed text-left text-sm">
        <caption className="sr-only">Administrative and security audit events</caption>
        <thead>
          <tr className="border-b border-[var(--border-subtle)] text-xs uppercase tracking-wider text-[var(--text-muted)]">
            <th scope="col" className="w-[19%] px-4 py-3 font-medium">
              Timestamp
            </th>
            <th scope="col" className="w-[22%] px-4 py-3 font-medium">
              Actor
            </th>
            <th scope="col" className="w-[17%] px-4 py-3 font-medium">
              Action
            </th>
            <th scope="col" className="w-[28%] px-4 py-3 font-medium">
              Target
            </th>
            <th scope="col" className="w-[14%] px-4 py-3 text-right font-medium">
              Details
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const expanded = expandedIds.has(entry.id);
            const detailsId = `audit-details-desktop-${entry.id}`;

            return (
              <Fragment key={entry.id}>
                <tr className="border-b border-[var(--border-subtle)]">
                  <td className="px-4 py-3 align-top text-xs text-[var(--text-muted)]">
                    <time dateTime={entry.createdAt} title={entry.createdAt}>
                      {formatTimestamp(entry.createdAt)}
                    </time>
                  </td>
                  <td className="px-4 py-3 align-top">
                    <p
                      className="truncate font-medium text-[var(--text-primary)]"
                      title={actorLabel(entry)}
                    >
                      {actorLabel(entry)}
                    </p>
                    {entry.actorEmail && entry.actorUserId && (
                      <p
                        className="mt-0.5 truncate font-mono text-xs text-[var(--text-muted)]"
                        title={entry.actorUserId}
                      >
                        {entry.actorUserId}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3 align-top">
                    <Badge variant="soft" className="max-w-full font-mono font-medium">
                      <span className="truncate" title={entry.action}>
                        {entry.action}
                      </span>
                    </Badge>
                  </td>
                  <td className="px-4 py-3 align-top">
                    <p className="truncate font-mono text-xs text-[var(--text-secondary)]">
                      <TargetCell entry={entry} />
                    </p>
                  </td>
                  <td className="px-4 py-2 text-right align-top">
                    <DetailsButton
                      entry={entry}
                      expanded={expanded}
                      detailsId={detailsId}
                      onToggle={() => onToggle(entry.id)}
                    />
                  </td>
                </tr>
                {expanded && (
                  <tr className="border-b border-[var(--border-subtle)]">
                    <td id={detailsId} colSpan={5} className="bg-[var(--bg-control)]/35 px-4 py-4">
                      <EventDetails entry={entry} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function MobileEventList({
  entries,
  expandedIds,
  onToggle,
}: {
  entries: AuditLogEntry[];
  expandedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <ul className="divide-y divide-[var(--border-subtle)] md:hidden">
      {entries.map((entry) => {
        const expanded = expandedIds.has(entry.id);
        const detailsId = `audit-details-mobile-${entry.id}`;

        return (
          <li key={entry.id} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Badge variant="soft" className="max-w-full font-mono font-medium">
                  <span className="truncate" title={entry.action}>
                    {entry.action}
                  </span>
                </Badge>
                <p className="mt-2 truncate text-sm font-medium" title={actorLabel(entry)}>
                  {actorLabel(entry)}
                </p>
              </div>
              <DetailsButton
                entry={entry}
                expanded={expanded}
                detailsId={detailsId}
                onToggle={() => onToggle(entry.id)}
              />
            </div>

            <dl className="mt-3 grid gap-2 text-xs">
              <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
                <dt className="text-[var(--text-muted)]">Timestamp</dt>
                <dd className="text-[var(--text-secondary)]">
                  <time dateTime={entry.createdAt} title={entry.createdAt}>
                    {formatTimestamp(entry.createdAt)}
                  </time>
                </dd>
              </div>
              <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
                <dt className="text-[var(--text-muted)]">Target</dt>
                <dd
                  className="truncate font-mono text-[var(--text-secondary)]"
                  title={targetLabel(entry)}
                >
                  {targetLabel(entry)}
                </dd>
              </div>
            </dl>

            {expanded && (
              <div id={detailsId} className="mt-4 border-t border-[var(--border-subtle)] pt-4">
                <EventDetails entry={entry} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
