import type { UIMessage } from 'ai';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { ReplySwitch } from '~/components/chat/reply-switcher';
import { activateReply } from '~/lib/chat-history';

type SetMessages = (update: (current: UIMessage[]) => UIMessage[]) => void;

/** The latest user turn and the reply to it on screen, if there is one. */
function latestTurn(messages: UIMessage[]) {
  const promptIndex = messages.findLastIndex((message) => message.role === 'user');
  const prompt = messages[promptIndex];
  if (!prompt) return null;
  const last = messages.at(-1);
  const active = promptIndex < messages.length - 1 && last?.role === 'assistant' ? last : null;
  return { prompt, active };
}

/** The turn's known replies in order, with the one on screen in its live form. */
function withActiveReply(known: UIMessage[], active: UIMessage | null): UIMessage[] {
  if (!active) return known;
  return known.some((reply) => reply.id === active.id)
    ? known.map((reply) => (reply.id === active.id ? active : reply))
    : [...known, active];
}

/**
 * Switching between the replies to the latest turn. The transcript shows one
 * reply per turn; the others are kept here, keyed by their prompt, from the
 * server's `replies` and from every reply a retry replaces in this session.
 *
 * A switch updates the transcript at once and is then saved. While it is
 * being saved the controls are unavailable, and anything that would start a
 * reply (retry, send) should first await `settled()` so the server's context
 * matches what is on screen. A failed save restores the previous reply.
 */
export function useReplySwitcher(options: {
  threadId: string;
  initialMessages: UIMessage[];
  initialReplies: UIMessage[];
  messages: UIMessage[];
  setMessages: SetMessages;
  streaming: boolean;
}) {
  const { threadId, messages, setMessages, streaming } = options;
  const [known, setKnown] = useState<Record<string, UIMessage[]>>(() => {
    const turn = latestTurn(options.initialMessages);
    return turn && options.initialReplies.length > 1
      ? { [turn.prompt.id]: options.initialReplies }
      : {};
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<Promise<void>>(Promise.resolve());
  const latest = useRef({ messages, known });
  latest.current = { messages, known };

  /** Keep the reply on screen among its turn's replies before it is replaced. */
  const remember = useCallback(() => {
    const turn = latestTurn(latest.current.messages);
    if (!turn?.active) return;
    const { prompt, active } = turn;
    setKnown((current) => ({
      ...current,
      [prompt.id]: withActiveReply(current[prompt.id] ?? [], active),
    }));
  }, []);

  const select = useCallback(
    (index: number) => {
      const turn = latestTurn(latest.current.messages);
      if (!turn?.active) return;
      const previous = turn.active;
      const replies = withActiveReply(latest.current.known[turn.prompt.id] ?? [], previous);
      const target = replies[index];
      if (!target || target.id === previous.id) return;

      setKnown((current) => ({ ...current, [turn.prompt.id]: replies }));
      const swap = (from: UIMessage, to: UIMessage) =>
        setMessages((current) =>
          current.at(-1)?.id === from.id ? [...current.slice(0, -1), to] : current,
        );
      swap(previous, target);
      setSaving(true);
      setError(null);
      pending.current = activateReply(threadId, target.id)
        .catch(() => {
          swap(target, previous);
          setError('The reply could not be switched. Try again.');
        })
        .finally(() => setSaving(false));
    },
    [threadId, setMessages],
  );

  const settled = useCallback(() => pending.current, []);

  const turn = latestTurn(messages);
  const replies = turn ? withActiveReply(known[turn.prompt.id] ?? [], turn.active) : [];
  const index = turn?.active ? replies.findIndex((reply) => reply.id === turn.active!.id) : -1;
  const count = replies.length;
  const disabled = streaming || saving;
  const switcher = useMemo<ReplySwitch | undefined>(
    () => (count > 1 && index >= 0 ? { index, count, disabled, onSelect: select } : undefined),
    [count, index, disabled, select],
  );

  return { switcher, remember, settled, error };
}
