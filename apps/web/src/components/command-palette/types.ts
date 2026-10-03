import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sidebarOpen: boolean;
  onSidebarOpenChange: (open: boolean) => void;
}

export interface PaletteItem {
  id: string;
  label: string;
  keywords?: string;
  icon: LucideIcon;
  /** Richer rendering than the label, such as a search result's snippets. */
  content?: ReactNode;
  /** The global shortcut for the same action, shown beside the label. */
  shortcut?: string[];
  /** Keep focus where the selection put it instead of restoring it on close. */
  keepFocusOnClose?: boolean;
  onSelect: () => void | Promise<void>;
}

export interface PaletteGroup {
  id: string;
  label: string;
  items: PaletteItem[];
}
