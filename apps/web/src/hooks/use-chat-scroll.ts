import type { UIMessage } from 'ai';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Within this distance of the bottom, the view keeps following new content. */
const FOLLOW_THRESHOLD_PX = 64;
/** Breathing room above a question pinned to the top of the view. */
const PIN_OFFSET_PX = 16;

function userMessageCount(messages: UIMessage[]): number {
  let count = 0;
  for (const message of messages) if (message.role === 'user') count += 1;
  return count;
}

/**
 * Scroll behaviour for a conversation.
 *
 * - Opening a conversation shows its end.
 * - Sending a question moves it to the top of the view, leaving room below
 *   for the reply. A spacer after the transcript provides that room.
 * - While the view is at the bottom it follows new content, so a streaming
 *   reply stays in sight once it fills the screen. The spacer shrinks as the
 *   reply grows, so the question stays put until the reply reaches the bottom.
 * - Scrolling up stops following; `jumpToLatest` resumes it.
 *
 * Both behaviours are one mechanism: "stay at the bottom" plus a spacer sized
 * so the bottom is the pinned question. Scrolls are instant so programmatic
 * movement never looks like the reader scrolling away.
 *
 * A send is recognised by the number of user messages growing, not by new
 * message ids: a just-sent question is re-identified with its saved id when
 * the reply settles, and that must not count as another send. The pinned
 * question is likewise found by its position among user messages.
 */
export function useChatScroll(messages: UIMessage[], streaming: boolean) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  /** Zero-based position of the pinned question among user messages. */
  const pinnedIndex = useRef<number | null>(null);
  const userCount = useRef<number | null>(null);
  const lastScrollTop = useRef(0);
  const [detached, setDetached] = useState(false);

  /** Size the spacer so the pinned question can sit at the top of the view. */
  const measure = useCallback(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    const spacer = spacerRef.current;
    if (!scroller || !content || !spacer) return;
    const pinned =
      pinnedIndex.current === null
        ? null
        : content.querySelectorAll<HTMLElement>('[data-message-role="user"]')[pinnedIndex.current];
    let height = 0;
    if (pinned) {
      const fromPinned =
        content.getBoundingClientRect().bottom - pinned.getBoundingClientRect().top + PIN_OFFSET_PX;
      height = Math.max(0, scroller.clientHeight - fromPinned);
    }
    spacer.style.height = `${height}px`;
  }, []);

  const scrollToBottom = useCallback(() => {
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, []);

  /** Re-measure and, while following, keep the end of the conversation in view. */
  const settle = useCallback(() => {
    measure();
    if (following.current) scrollToBottom();
  }, [measure, scrollToBottom]);

  // Decide what each change to the transcript means before the browser paints.
  useLayoutEffect(() => {
    const count = userMessageCount(messages);
    if (userCount.current === null) {
      // Arriving mid-reply (a conversation started from the home page): the
      // question was just sent, so treat it like any other send.
      if (streaming && count > 0) pinnedIndex.current = count - 1;
      following.current = true;
    } else if (count > userCount.current) {
      pinnedIndex.current = count - 1;
      following.current = true;
      setDetached(false);
    }
    userCount.current = count;
    settle();
  }, [messages, streaming, settle]);

  // Content and window size change during streaming, images and edits.
  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => settle());
    observer.observe(content);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [settle]);

  /**
   * Only the reader moving up stops following; reaching the bottom resumes it.
   *
   * Scroll events arrive after the scroll that caused them, so the event for
   * our own move to the bottom can be handled once the reply has grown again
   * and the view is no longer at the bottom. Treating that as "scrolled away"
   * would stop following mid-reply. Downward moves (ours, or the browser's
   * scroll anchoring) therefore never detach.
   */
  const onScroll = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const top = scroller.scrollTop;
    const movedUp = top < lastScrollTop.current - 1;
    lastScrollTop.current = top;
    const distance = scroller.scrollHeight - top - scroller.clientHeight;
    if (distance <= FOLLOW_THRESHOLD_PX) {
      following.current = true;
      setDetached(false);
    } else if (movedUp) {
      following.current = false;
      setDetached(true);
    }
  }, []);

  const jumpToLatest = useCallback(() => {
    following.current = true;
    setDetached(false);
    scrollToBottom();
  }, [scrollToBottom]);

  return { scrollRef, contentRef, spacerRef, onScroll, detached, jumpToLatest };
}
