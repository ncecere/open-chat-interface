import { useState } from 'react';
import { Composer } from '~/components/chat/composer';
import { DEFAULT_PROMPTS, SUGGESTION_CATEGORIES } from '~/components/chat/suggestions';
import { useCurrentUser } from '~/hooks/use-current-user';
import { cn } from '~/lib/utils';

type CategoryId = (typeof SUGGESTION_CATEGORIES)[number]['id'];

export function ChatHomePage() {
  const { data } = useCurrentUser();
  const [activeCategory, setActiveCategory] = useState<CategoryId | null>(null);
  const [draft, setDraft] = useState('');

  const firstName = data?.user.name.split(' ')[0];
  const prompts =
    SUGGESTION_CATEGORIES.find((category) => category.id === activeCategory)?.prompts ??
    DEFAULT_PROMPTS;

  return (
    <div className="flex h-full flex-col">
      {/* Landing content sits in the upper-middle region, not vertically centered. */}
      <div className="flex-1 overflow-y-auto px-4 pt-[18vh]">
        <div className="mx-auto w-full max-w-[41.75rem]">
          <h1 className="text-[1.875rem] font-bold leading-tight tracking-tight">
            How can I help you{firstName ? `, ${firstName}` : ''}?
          </h1>

          <div className="mt-7 flex flex-wrap gap-2.5">
            {SUGGESTION_CATEGORIES.map((category) => {
              const active = activeCategory === category.id;
              return (
                <button
                  key={category.id}
                  type="button"
                  onClick={() => setActiveCategory(active ? null : category.id)}
                  className={cn(
                    'inline-flex h-[2.375rem] items-center gap-2 rounded-xl px-5 text-sm font-medium transition-colors',
                    '[&_svg]:size-4 [&_svg]:shrink-0',
                    active
                      ? 'bg-[var(--accent)] text-[var(--accent-foreground)]'
                      : 'bg-[var(--bg-control-alt)] text-[var(--text-secondary)] hover:bg-[var(--bg-control-hover)] hover:text-[var(--text-primary)]',
                  )}
                >
                  <category.icon />
                  {category.label}
                </button>
              );
            })}
          </div>

          <div className="mt-9">
            {prompts.map((prompt, index) => (
              <button
                key={prompt}
                type="button"
                onClick={() => setDraft(prompt)}
                className={cn(
                  'block h-[3.0625rem] w-full pr-8 text-left text-[0.9375rem] text-[var(--text-secondary)]',
                  'transition-colors hover:text-[var(--text-primary)]',
                  index < prompts.length - 1 && 'border-b border-[var(--border-subtle)]/45',
                )}
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>
      </div>

      <Composer value={draft} onChange={setDraft} onSubmit={() => undefined} />
    </div>
  );
}
