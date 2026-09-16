import type { LucideIcon } from 'lucide-react';

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
  onSelect: () => void | Promise<void>;
}

export interface PaletteGroup {
  id: string;
  label: string;
  items: PaletteItem[];
}
