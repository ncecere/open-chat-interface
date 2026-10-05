import type { ReactNode } from 'react';

/**
 * The little Markdown an announcement needs (#86): **bold** and
 * [links](https://…), with line breaks kept. Everything else is shown as
 * typed. Built from React text nodes, never HTML, so a message cannot inject
 * markup; a link must be https, http, mailto or a path on this site.
 */
const TOKEN = /\*\*([^*\n]+?)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

export function safeHref(url: string): string | null {
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  try {
    const parsed = new URL(url);
    return ['https:', 'http:', 'mailto:'].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

export function InlineMarkdown({ text }: { text: string }) {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const [whole, bold, label, url] = match;
    const index = match.index ?? 0;
    if (index > last) nodes.push(text.slice(last, index));
    if (bold !== undefined) {
      nodes.push(<strong key={index}>{bold}</strong>);
    } else {
      const href = safeHref(url ?? '');
      nodes.push(
        href ? (
          <a
            key={index}
            href={href}
            {...(href.startsWith('/') ? {} : { target: '_blank', rel: 'noreferrer' })}
            className="font-medium underline underline-offset-2"
          >
            {label}
          </a>
        ) : (
          whole
        ),
      );
    }
    last = index + whole.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return <span className="whitespace-pre-line">{nodes}</span>;
}
