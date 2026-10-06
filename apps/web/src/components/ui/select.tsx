import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import type { ComponentProps, ReactNode, SyntheticEvent } from 'react';
import { useRef, useState } from 'react';
import { keepHiddenContentInert } from '~/lib/inert-hidden';
import { cn } from '~/lib/utils';
import { HELD_CLASS, useHoldFocus } from './hold-focus';
import { MENU_ITEM_FOCUS } from './item-focus';

// An open Select hides the page; it is also made inert, so nothing hidden takes focus (#172).
keepHiddenContentInert();

export const SelectRoot = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export function SelectTrigger({
  className,
  children,
  valueTitle,
  ...props
}: ComponentProps<typeof SelectPrimitive.Trigger> & {
  /** The chosen option's full text, as a tooltip when the trigger cuts it short (#130). */
  valueTitle?: string;
}) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        'flex h-9 w-full items-center justify-between gap-2 rounded-lg px-3 text-sm',
        'border border-[var(--border-subtle)] bg-[var(--bg-control)] text-[var(--text-primary)]',
        'transition-colors hover:bg-[var(--bg-control-hover)]',
        // The 2 px accent ring every other control gets from :focus-visible
        // (#239). A border step alone was 1.2:1 against the unfocused one, so a
        // keyboard user could not see which row's role select had focus.
        'focus-visible:border-[var(--border-strong)]',
        'focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2',
        'focus-visible:outline-[var(--accent-bright)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        // A placeholder should read as absence rather than as a value.
        'data-[placeholder]:text-[var(--text-muted)]',
        className,
      )}
      {...props}
    >
      <span className="min-w-0 truncate text-left" title={valueTitle}>
        {children}
      </span>
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="size-4 shrink-0 text-[var(--text-muted)]" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

/**
 * A long list scrolls, and a scrolling region must be focusable or hold
 * something in the tab order (WCAG 2.1.1, axe scrollable-region-focusable).
 * Radix scrolls its viewport, a presentational div, and its options are out of
 * the tab order, so the 40-action audit filter failed (#274); a focusable
 * viewport would be a focusable child the listbox does not allow. So the
 * listbox itself scrolls and is in the tab order, as a listbox may be; the
 * viewport keeps its natural height. Radix still keeps Tab inside the popup
 * and moves focus between the options; a focused option scrolls into view.
 */
const VIEWPORT_DOES_NOT_SCROLL = { overflow: 'visible', flex: 'none' } as const;

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
        tabIndex={0}
        className={cn(
          'z-50 max-h-72 min-w-[var(--radix-select-trigger-width)]',
          'scrollbar-thin overflow-y-auto overscroll-contain',
          'rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]',
          'text-[var(--text-primary)] shadow-[var(--shadow-popover)]',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-1.5" style={VIEWPORT_DOES_NOT_SCROLL}>
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
        'text-sm transition-colors',
        // A visible ring on the keyboard-focused option, as in menus (#135).
        MENU_ITEM_FOCUS,
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
 * A select that saves on change (a user's role) disables itself while it
 * saves, so the trigger focus returns to when the popup closes was already
 * disabled and focus fell to the body (#292). While it is disabled and focus is
 * on the trigger or in its popup, the trigger stays focusable but
 * aria-disabled and ignores the pointer and key presses that open it, as the
 * shared Button does (#269); a choice made meanwhile is ignored.
 */
function useSelectHold(disabled: boolean | undefined, onChange: (value: string) => void) {
  const { hold, track, setFocused } = useHoldFocus(disabled);
  const contentRef = useRef<HTMLDivElement>(null);
  const block = (event: SyntheticEvent) => {
    if (hold) event.preventDefault();
  };
  return {
    hold,
    rootProps: {
      disabled: hold ? false : disabled,
      onValueChange: (next: string) => {
        if (!disabled) onChange(fromRadixValue(next));
      },
    },
    triggerProps: {
      'aria-disabled': hold || undefined,
      // Focus moving into the popup and back keeps the hold.
      ...track<HTMLButtonElement>(undefined, undefined, (target) =>
        Boolean(contentRef.current?.contains(target)),
      ),
      onPointerDown: block,
      onKeyDown: block,
      onClick: block,
    },
    contentProps: { ref: contentRef, onFocus: () => setFocused(true) },
  };
}

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
  // The popup's listbox is named like the field (#114): by its aria-label, or
  // else by the <label> pointing at it, read when the popup opens.
  const [labelText, setLabelText] = useState<string | undefined>(undefined);
  const held = useSelectHold(disabled, onChange);
  return (
    <SelectRoot
      value={toRadixValue(value)}
      {...held.rootProps}
      onOpenChange={(open) => {
        if (!open || ariaLabel || !id) return;
        const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        setLabelText(label?.textContent?.trim() || undefined);
      }}
    >
      <SelectTrigger
        {...held.triggerProps}
        id={id}
        className={cn(className, held.hold && HELD_CLASS)}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        valueTitle={options.find((option) => option.value === value)?.label}
      >
        <SelectValue placeholder={placeholder ?? 'Select an option'} />
      </SelectTrigger>
      <SelectContent {...held.contentProps} aria-label={ariaLabel ?? labelText}>
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
  // The popup's listbox is named like the field (#114): by its aria-label, or
  // else by the <label> pointing at it, read when the popup opens.
  const [labelText, setLabelText] = useState<string | undefined>(undefined);
  const held = useSelectHold(disabled, onChange);
  return (
    <SelectRoot
      value={toRadixValue(value)}
      {...held.rootProps}
      onOpenChange={(open) => {
        if (!open || ariaLabel || !id) return;
        const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        setLabelText(label?.textContent?.trim() || undefined);
      }}
    >
      <SelectTrigger
        {...held.triggerProps}
        id={id}
        className={cn(className, held.hold && HELD_CLASS)}
        aria-label={ariaLabel}
        valueTitle={
          groups.flatMap((group) => group.options).find((option) => option.value === value)?.label
        }
      >
        <SelectValue placeholder={placeholder ?? 'Select an option'} />
      </SelectTrigger>
      <SelectContent {...held.contentProps} aria-label={ariaLabel ?? labelText}>
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
