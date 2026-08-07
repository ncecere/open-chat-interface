import { code } from '@streamdown/code';
import { createMathPlugin } from '@streamdown/math';
import type { UIMessage } from 'ai';
import { Brain, Check, ChevronRight, Copy, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Streamdown } from 'streamdown';
import { Button } from '~/components/ui/button';
import { cn } from '~/lib/utils';

/**
 * Syntax highlighting and KaTeX are opt-in Streamdown plugins. Single-dollar
 * inline math is off by default, but models commonly emit it.
 */
const PLUGINS = { code, math: createMathPlugin({ singleDollarTextMath: true }) };

function textOf(message: UIMessage): string {
  return message.parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function reasoningOf(message: UIMessage): string {
  return message.parts
    .filter((part): part is { type: 'reasoning'; text: string } => part.type === 'reasoning')
    .map((part) => part.text)
    .join('\n');
}

function ReasoningPanel({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mb-3 overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-control)]/50">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[0.8125rem] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
      >
        <Brain className="size-4 shrink-0" />
        <span className="flex-1">{streaming ? 'Thinking...' : 'Reasoning'}</span>
        <ChevronRight className={cn('size-4 transition-transform', open && 'rotate-90')} />
      </button>

      {open && (
        <div className="border-t border-[var(--border-subtle)] px-3 py-2 text-[0.8125rem] leading-relaxed text-[var(--text-muted)]">
          <Streamdown plugins={PLUGINS}>{text}</Streamdown>
        </div>
      )}
    </div>
  );
}

function MessageActions({ text, onRetry }: { text: string; onRetry?: () => void }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="mt-2 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Copy message"
        onClick={async () => {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="text-[var(--success)]" /> : <Copy />}
      </Button>

      {onRetry && (
        <Button variant="ghost" size="icon-sm" aria-label="Retry" onClick={onRetry}>
          <RefreshCw />
        </Button>
      )}
    </div>
  );
}

export function MessageList({
  messages,
  streaming,
  onRetry,
}: {
  messages: UIMessage[];
  streaming: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-[42rem] flex-col gap-6 px-4 py-8">
      {messages.map((message, index) => {
        const text = textOf(message);
        const reasoning = reasoningOf(message);
        const isLast = index === messages.length - 1;

        if (message.role === 'user') {
          return (
            <div key={message.id} className="group flex flex-col items-end">
              <div className="max-w-[85%] rounded-2xl bg-[var(--bg-control)] px-4 py-3 text-[0.9375rem] leading-relaxed text-[var(--text-primary)]">
                <Streamdown plugins={PLUGINS}>{text}</Streamdown>
              </div>
              <MessageActions text={text} />
            </div>
          );
        }

        return (
          <div key={message.id} className="group flex flex-col">
            {reasoning && <ReasoningPanel text={reasoning} streaming={streaming && isLast} />}

            <div className="text-[0.9375rem] leading-relaxed text-[var(--text-secondary)]">
              <Streamdown
                plugins={PLUGINS}
                className={cn(
                  'prose-headings:font-semibold prose-headings:text-[var(--text-primary)]',
                  '[&_a]:text-[var(--accent-bright)] [&_a]:underline-offset-2',
                  '[&_strong]:text-[var(--text-primary)]',
                  '[&_code]:rounded [&_code]:bg-[var(--bg-control)] [&_code]:px-1 [&_code]:py-0.5',
                  '[&_pre]:rounded-xl [&_pre]:border [&_pre]:border-[var(--border-subtle)]',
                  '[&_hr]:border-[var(--border-subtle)]',
                  '[&_li::marker]:text-[var(--accent-bright)]',
                )}
              >
                {text}
              </Streamdown>
            </div>

            {!(streaming && isLast) && (
              <MessageActions text={text} onRetry={isLast ? onRetry : undefined} />
            )}
          </div>
        );
      })}

      {streaming && messages.at(-1)?.role === 'user' && (
        <div className="flex gap-1.5 py-2">
          {[0, 1, 2].map((dot) => (
            <span
              key={dot}
              className="size-1.5 animate-bounce rounded-full bg-[var(--text-muted)]"
              style={{ animationDelay: `${dot * 0.15}s` }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
