import { createContext, useContext } from 'react';

/**
 * A field's hint ("Separate addresses with commas", "12 to 200 characters.")
 * sat after its control as a bare paragraph, so a screen reader reached the
 * control with only its name and the rule went unheard unless the user read
 * on (#295, WCAG 1.3.1 / 3.3.2). `Field` gives its hint an id and provides it
 * here; the shared controls inside it (Input, Textarea, Select, Switch) add it
 * to their `aria-describedby`, so every form built with Field gets it.
 */
export const FieldHintContext = createContext<string | undefined>(undefined);

/** The id of the hint under the control `id`, for controls built by hand. */
export const fieldHintId = (id: string) => `${id}-hint`;

/** Ids joined for `aria-describedby`, each once; undefined when there are none. */
export function describedByIds(...ids: Array<string | false | null | undefined>) {
  const unique = [...new Set(ids.flatMap((id) => (id ? id.split(/\s+/) : [])).filter(Boolean))];
  return unique.length ? unique.join(' ') : undefined;
}

/** A control's `aria-describedby`: its own ids, then the hint of the Field it is in. */
export function useFieldDescribedBy(describedBy?: string): string | undefined {
  return describedByIds(describedBy, useContext(FieldHintContext));
}
