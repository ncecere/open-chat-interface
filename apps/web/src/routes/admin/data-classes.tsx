import { Link } from '@tanstack/react-router';
import { AdminPageHeader, LoadError } from '~/components/admin/admin-ui';
import { useAdminDataClasses } from '~/components/admin/data-class-select';
import { ClassList } from '~/components/admin/data-classes/class-list';
import { ModeSection, UpgradeBanners } from '~/components/admin/data-classes/mode-section';
import { ServicesSection } from '~/components/admin/data-classes/services-section';
import { Spinner } from '~/components/ui/spinner';
import { useAdminClassification } from '~/hooks/use-admin-classification';

/**
 * Data classes (v0.14, #395): which kinds of data exist, which models,
 * connectors and outside services may handle them, and whether OCI refuses
 * (Block) or only warns (Warn) when labelled content would reach one that is
 * not approved. See docs/admin/data-classification.md.
 */
export function AdminDataClassesPage() {
  const settings = useAdminClassification();
  const classes = useAdminDataClasses();

  return (
    <div>
      <AdminPageHeader
        title="Data classes"
        description="Say which kinds of data a conversation can carry, and which models, connectors and services may handle each. A model is approved for nothing until you approve it, and a conversation with no label is never affected."
      />
      {settings.isLoading || classes.isLoading ? (
        <div className="py-8" role="status" aria-label="Loading data classes">
          <Spinner className="mx-auto size-6" />
        </div>
      ) : settings.isError || !settings.data ? (
        <LoadError title="Data classification settings could not be loaded." query={settings} />
      ) : classes.isError || !classes.data ? (
        <LoadError title="Data classes could not be loaded." query={classes} />
      ) : (
        <div className="flex flex-col gap-10">
          <UpgradeBanners settings={settings.data} />
          <ModeSection settings={settings.data} />
          <ClassList classes={classes.data} />
          <ServicesSection settings={settings.data} classes={classes.data} />
          <p className="text-sm text-[var(--text-muted)]">
            Approve models under{' '}
            <Link to="/admin/models" className="underline">
              Providers &amp; Models
            </Link>{' '}
            and say what each connector carries under{' '}
            <Link to="/admin/connectors" className="underline">
              Connectors
            </Link>
            . To label a person’s project yourself, open the person under{' '}
            <Link to="/admin/users" className="underline">
              Users
            </Link>
            .
          </p>
        </div>
      )}
    </div>
  );
}
