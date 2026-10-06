import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { Check } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '~/lib/utils';
import { MENU_ITEM_FOCUS } from './item-focus';

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuGroup = DropdownMenuPrimitive.Group;
export const DropdownMenuSub = DropdownMenuPrimitive.Sub;
export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

// Every kind of item marks keyboard focus the same visible way (#135).
const ITEM_CLASSES = cn(
  'relative flex cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm',
  'text-[var(--text-secondary)] transition-colors',
  MENU_ITEM_FOCUS,
  'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
  '[&_svg]:size-4 [&_svg]:shrink-0',
);

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 min-w-52 overflow-hidden rounded-xl border border-[var(--border-subtle)]',
          'bg-[var(--bg-elevated)] p-1.5 text-[var(--text-primary)]',
          'shadow-[var(--shadow-popover)]',
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

export function DropdownMenuSubTrigger({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.SubTrigger>) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      className={cn(ITEM_CLASSES, 'data-[state=open]:bg-[var(--bg-control-hover)]', className)}
      {...props}
    />
  );
}

export function DropdownMenuSubContent({
  className,
  sideOffset = 6,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.SubContent
        sideOffset={sideOffset}
        className={cn(
          'z-50 min-w-40 overflow-hidden rounded-xl border border-[var(--border-subtle)]',
          'bg-[var(--bg-elevated)] p-1.5 text-[var(--text-primary)] shadow-[var(--shadow-popover)]',
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

export function DropdownMenuItem({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Item>) {
  return <DropdownMenuPrimitive.Item className={cn(ITEM_CLASSES, className)} {...props} />;
}

/**
 * One choice of several (menuitemradio): the chosen one is announced as
 * checked, not only shown with a tick (#92).
 */
export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem className={cn(ITEM_CLASSES, className)} {...props}>
      {children}
      <DropdownMenuPrimitive.ItemIndicator className="ml-auto">
        <Check className="text-[var(--accent-bright)]" />
      </DropdownMenuPrimitive.ItemIndicator>
    </DropdownMenuPrimitive.RadioItem>
  );
}

/** Something on or off (menuitemcheckbox), announced as checked or not (#92). */
export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem className={cn(ITEM_CLASSES, className)} {...props}>
      {children}
      <DropdownMenuPrimitive.ItemIndicator className="ml-auto">
        <Check className="text-[var(--accent-bright)]" />
      </DropdownMenuPrimitive.ItemIndicator>
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      className={cn('-mx-1.5 my-1.5 h-px bg-[var(--border-subtle)]', className)}
      {...props}
    />
  );
}

export function DropdownMenuLabel({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      className={cn(
        'px-2.5 py-1.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-[var(--text-muted)]',
        className,
      )}
      {...props}
    />
  );
}
