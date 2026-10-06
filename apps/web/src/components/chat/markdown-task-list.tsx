import { type ComponentProps, createContext, useContext } from 'react';
import { cn } from '~/lib/utils';

/**
 * Task lists in Markdown (`- [x] Draft the plan`) with a name for each
 * checkbox (#240). GFM renders every item as a bare disabled
 * `<input type="checkbox">` beside its text, with nothing tying the two
 * together: axe reported `label` (critical) once per item, and a screen
 * reader said "checkbox, checked, dimmed" with no item. Each checkbox is now
 * named by its item's own text (nested lists left out), given to it by the
 * list item it sits in.
 */

/** The smallest part of a hast node read here; Streamdown passes the item's node. */
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  children?: HastNode[];
}

const TaskItemName = createContext<string | undefined>(undefined);

/** The words of a list item, without its nested lists. */
function itemText(node: HastNode | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.value ?? '';
  if (node.tagName === 'ul' || node.tagName === 'ol') return '';
  return (node.children ?? []).map(itemText).join('');
}

type ListItemProps = ComponentProps<'li'> & { node?: HastNode };

/** Streamdown's own list item (same classes and marker), plus the name for its checkbox. */
function ListItem({ node, className, children, ...props }: ListItemProps) {
  const item = (
    <li className={cn('py-1 [&>p]:inline', className)} data-streamdown="list-item" {...props}>
      {children}
    </li>
  );
  if (!className?.split(/\s+/).includes('task-list-item')) return item;
  const name = itemText(node).replace(/\s+/g, ' ').trim();
  return <TaskItemName.Provider value={name || undefined}>{item}</TaskItemName.Provider>;
}

/** A task item's checkbox, named by its item; any other input as it was. */
function TaskCheckbox({ node: _node, ...props }: ComponentProps<'input'> & { node?: unknown }) {
  const name = useContext(TaskItemName);
  if (props.type !== 'checkbox') return <input {...props} />;
  return <input {...props} aria-label={name} />;
}

export const TASK_LIST_COMPONENTS = { li: ListItem, input: TaskCheckbox };
