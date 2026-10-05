import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '~/lib/utils';

export const SelectRoot = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export function SelectTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        'flex h-9 w-full items-center justify-between gap-2 rounded-lg px-3 text-sm',
        'border border-[var(--border-subtle)] bg-[var(--bg-control)] text-[var(--text-primary)]',
        'transition-colors hover:bg-[var(--bg-control-hover)]',
        'focus-visible:border-[var(--border-strong)] focus-visible:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
        // A placeholder should read as absence rather than as a value.
        'data-[placeholder]:text-[var(--text-muted)]',
        className,
      )}
      {...props}
    >
      <span className="min-w-0 truncate text-left">{children}</span>
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="size-4 shrink-0 text-[var(--text-muted)]" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({
  className,
  children,
  position = 'popper',
  ...props
}: ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position={position}
        sideOffset={6}
        className={cn(
          'z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden',
          'rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]',
          'text-[var(--text-primary)] shadow-[var(--shadow-popover)]',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="scrollbar-thin max-h-72 overflow-y-auto p-1.5">
          {children}
        </SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        'relative flex cursor-pointer select-none items-center gap-2 rounded-lg py-2 pr-2 pl-8',
        'text-sm outline-none transition-colors',
        'data-[highlighted]:bg-[var(--bg-control-hover)]',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      <span className="absolute left-2 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="size-3.5 text-[var(--accent-bright)]" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

export function SelectLabel({ className, ...props }: ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      className={cn('px-2 py-1.5 font-medium text-[var(--text-muted)] text-xs', className)}
      {...props}
    />
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/**
 * Radix reserves the empty string to mean "nothing selected", so an option
 * that legitimately represents an empty value — "No lab", "Latest messages" —
 * cannot use it directly. Callers keep passing '' and the substitution is
 * handled here rather than at every call site.
 */
const EMPTY_VALUE = '__empty__';

const toRadixValue = (value: string) => (value === '' ? EMPTY_VALUE : value);
const fromRadixValue = (value: string) => (value === EMPTY_VALUE ? '' : value);

/**
 * A styled select over the native element.
 *
 * The signature mirrors `<select>` — `value`, `onChange`, `id`, `disabled` —
 * so a caller reads the same way it did before, but the menu is rendered by
 * the application rather than the operating system. That is the whole point:
 * a native dropdown ignores the instance theme entirely and looks foreign
 * beside every other control.
 */
export function Select({
  value,
  onChange,
  options,
  id,
  disabled,
  placeholder,
  className,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
}: {
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  id?: string;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  'aria-label'?: string;
  /** A note about the field, such as why it is disabled. */
  'aria-describedby'?: string;
}) {
  return (
    <SelectRoot
      value={toRadixValue(value)}
      onValueChange={(next) => onChange(fromRadixValue(next))}
      disabled={disabled}
    >
      <SelectTrigger
        id={id}
        className={className}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
      >
        <SelectValue placeholder={placeholder ?? 'Select an option'} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={toRadixValue(option.value)}
            disabled={option.disabled}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  );
}

/** Groups of options, for a select whose choices fall into families. */
export function GroupedSelect({
  value,
  onChange,
  groups,
  id,
  disabled,
  placeholder,
  className,
  'aria-label': ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  groups: ReadonlyArray<{ label: string; options: readonly SelectOption[] }>;
  id?: string;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  'aria-label'?: string;
}) {
  return (
    <SelectRoot
      value={toRadixValue(value)}
      onValueChange={(next) => onChange(fromRadixValue(next))}
      disabled={disabled}
    >
      <SelectTrigger id={id} className={className} aria-label={ariaLabel}>
        <SelectValue placeholder={placeholder ?? 'Select an option'} />
      </SelectTrigger>
      <SelectContent>
        {groups.map((group) => (
          <SelectGroup key={group.label}>
            <SelectLabel>{group.label}</SelectLabel>
            {group.options.map((option) => (
              <SelectItem
                key={option.value}
                value={toRadixValue(option.value)}
                disabled={option.disabled}
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </SelectRoot>
  );
}

/** Renders arbitrary content in a trigger, for options that need an icon. */
export function SelectTriggerContent({ children }: { children: ReactNode }) {
  return <span className="flex min-w-0 items-center gap-2">{children}</span>;
}
