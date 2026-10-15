import type { UIMessage } from 'ai';
import { useEffect, useRef, useState } from 'react';
import { failureOf, interruptionOf, stoppedOf } from '~/components/chat/message-content';
import { useT } from '~/lib/i18n';

/**
 * How long nothing may be streaming before a reply counts as ended. A lost
 * connection hands over to the page following the reply on the server, and
 * for a moment neither is streaming: the pause keeps that from being read out
 * as an ending followed by a new reply.
 */
export const REPLY_SETTLE_MS = 600;

/**
 * What to say once a reply has ended. `alerted` is a failure: the page shows
 * it as an alert already, so the status says nothing more (two voices for one
 * event would read it twice). `none` is a turn nobody answered.
 */
export type ReplyOutcome = 'complete' | 'stopped' | 'alerted' | 'none';

/**
 * @param last The conversation's last message.
 * @param failed The conversation reports an error of its own (an alert on the page).
 */
export function replyOutcomeOf(last: UIMessage | undefined, failed: boolean): ReplyOutcome {
  if (failed) return 'alerted';
  if (last?.role !== 'assistant') return 'none';
  if (failureOf(last) !== null) return 'alerted';
  if (stoppedOf(last) || interruptionOf(last) !== null) return 'stopped';
  return 'complete';
}

/**
 * The text of the live region that tells a person who cannot see the page
 * that a reply is coming and that it has ended (WCAG 4.1.3, #401): once when
 * it starts, once when it ends, never the words, and not again while it
 * streams. The words are the reply itself, read when the person chooses to.
 */
export function useReplyAnnouncement(streaming: boolean, outcome: ReplyOutcome): string {
  const t = useT();
  const [text, setText] = useState('');
  // A reply has been announced and its end has not.
  const underWay = useRef(false);
  // Read when the pause is over, not when it began: a stopped reply is saved
  // as stopped a moment after the stream closes.
  const latest = useRef({ outcome, t });
  latest.current = { outcome, t };

  useEffect(() => {
    if (streaming) {
      if (underWay.current) return;
      underWay.current = true;
      setText(latest.current.t('chat.messageList.replyStarted'));
      return;
    }
    if (!underWay.current) return;
    const timer = setTimeout(() => {
      underWay.current = false;
      const { outcome: ended, t: say } = latest.current;
      setText(
        ended === 'complete'
          ? say('chat.messageList.replyComplete')
          : ended === 'stopped'
            ? say('chat.messageList.replyStopped')
            : '',
      );
    }, REPLY_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [streaming]);

  return text;
}
