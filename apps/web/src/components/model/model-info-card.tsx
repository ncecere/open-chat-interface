import { type CatalogModel, findModelLab } from '@oci/shared';
import { CapabilityPill } from '~/components/model/capability-pill';
import { LabLogo } from '~/components/model/lab-logo';

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count % 1_000_000 === 0 ? 0 : 1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}K`;
  return String(count);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="font-semibold text-[var(--text-primary)] text-base">{title}</h3>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-semibold text-[var(--text-primary)] text-base">{label}</dt>
      <dd className="mt-2 text-[var(--text-muted)] text-sm">{value}</dd>
    </div>
  );
}

/**
 * Everything known about a model.
 *
 * Sections are omitted rather than shown empty. A self-hosted catalogue is
 * often only partly filled in, and a column of "Unknown" tells the reader
 * nothing while making the card harder to scan.
 */
export function ModelInfoCard({ model }: { model: CatalogModel }) {
  const lab = findModelLab(model.labId);
  const description = model.description?.trim();

  return (
    <div className="flex flex-col gap-6 text-left">
      <div className="flex items-start gap-3">
        <LabLogo labId={model.labId} className="size-8 shrink-0" />
        <div className="min-w-0">
          <p className="font-semibold text-[var(--text-primary)] text-lg leading-tight">
            {model.displayName}
          </p>
          <p className="mt-1 text-[var(--text-muted)] text-sm">
            Available through {model.providerLabel}
          </p>
        </div>
      </div>

      {description && (
        <Section title="Description">
          <p className="text-[var(--text-secondary)] text-sm leading-relaxed">{description}</p>
        </Section>
      )}

      {model.capabilities.length > 0 && (
        <Section title="Features">
          <div className="flex flex-wrap gap-2">
            {model.capabilities.map((capability) => (
              <CapabilityPill key={capability} capability={capability} />
            ))}
          </div>
        </Section>
      )}

      <dl className="grid grid-cols-2 gap-x-6 gap-y-5">
        <Detail label="Provider" value={model.providerLabel} />
        {lab && <Detail label="Developer" value={lab.name} />}
        {model.contextWindow && (
          <Detail label="Context" value={`${formatTokens(model.contextWindow)} tokens`} />
        )}
        {model.maxOutputTokens && (
          <Detail label="Max output" value={`${formatTokens(model.maxOutputTokens)} tokens`} />
        )}
        {model.supportedEfforts.length > 0 && (
          <Detail label="Effort levels" value={model.supportedEfforts.join(', ')} />
        )}
      </dl>
    </div>
  );
}
