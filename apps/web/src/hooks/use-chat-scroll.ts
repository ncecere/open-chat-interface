import type { UIMessage } from 'ai';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Within this distance of the bottom, the view keeps following new content. */
const FOLLOW_THRESHOLD_PX = 64;
/** Breathing room above a question pinned to the top of the view. */
const PIN_OFFSET_PX = 16;

/**
 * Room above a pinned question: the breathing room, or enough to clear the
 * top bar's floating controls where they cover it (on a phone the
 * conversation runs under them).
 */
function pinOffset(scroller: HTMLElement, pinned: HTMLElement): number {
  const view = scroller.getBoundingClientRect();
  // The row spans the column; its first child is the bubble the person sees.
  const question = (pinned.firstElementChild ?? pinned).getBoundingClientRect();
  let offset = PIN_OFFSET_PX;
  for (const control of document.querySelectorAll<HTMLElement>('[data-floating-controls]')) {
    const box = control.getBoundingClientRect();
    const overlaps = box.left < question.right && box.right > question.left;
    if (overlaps && box.bottom > view.top) offset = Math.max(offset, box.bottom - view.top + 8);
  }
  return offset;
}
/**
 * How long an opened search match is held in the centre while late layout
 * (images, diagrams, code highlighting) settles, unless the reader scrolls.
 */
const TARGET_HOLD_MS = 1500;
/** How long a search match stays highlighted. */
const TARGET_HIGHLIGHT_MS = 2400;
/** Frames to wait for the view to become focusable (a closing drawer or dialog). */
const FOCUS_ATTEMPTS = 20;

/** A message to open at instead of the end. `key` changes on each request. */
export interface ChatScrollTarget {
  messageId: string;
  key: string;
}

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
 * - Opened at a message (conversation search), the view centres that message
 *   instead, highlights it briefly and moves focus to it. Everything else
 *   then behaves as above; jumping to latest or sending resumes following.
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
export function useChatScroll(
  messages: UIMessage[],
  streaming: boolean,
  target?: ChatScrollTarget,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  /** Zero-based position of the pinned question among user messages. */
  const pinnedIndex = useRef<number | null>(null);
  const userCount = useRef<number | null>(null);
  const lastScrollTop = useRef(0);
  const [detached, setDetached] = useState(false);
  /** The opened search match, held in the centre until this time. */
  const anchor = useRef<{ messageId: string; until: number } | null>(null);
  const handledTarget = useRef<string | null>(null);

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
        content.getBoundingClientRect().bottom -
        pinned.getBoundingClientRect().top +
        pinOffset(scroller, pinned);
      height = Math.max(0, scroller.clientHeight - fromPinned);
    }
    spacer.style.height = `${height}px`;
  }, []);

  const scrollToBottom = useCallback(() => {
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, []);

  const findMessage = useCallback((messageId: string) => {
    const content = contentRef.current;
    if (!content) return null;
    for (const row of content.querySelectorAll<HTMLElement>('[data-message-id]')) {
      if (row.dataset.messageId === messageId) return row;
    }
    return null;
  }, []);

  /** Centres a message, or aligns its top when it is taller than the view. */
  const centre = useCallback((element: HTMLElement) => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const top =
      element.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop;
    const room = Math.max(0, scroller.clientHeight - element.getBoundingClientRect().height);
    scroller.scrollTop = Math.max(0, top - room / 2);
    lastScrollTop.current = scroller.scrollTop;
  }, []);

  /** Re-measure and, while following, keep the end of the conversation in view. */
  const settle = useCallback(() => {
    measure();
    const held = anchor.current;
    if (held) {
      const element = performance.now() < held.until ? findMessage(held.messageId) : null;
      if (element) {
        centre(element);
        return;
      }
      anchor.current = null;
    }
    if (following.current) scrollToBottom();
  }, [measure, scrollToBottom, findMessage, centre]);

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
      anchor.current = null;
      setDetached(false);
    }
    userCount.current = count;
    settle();
  }, [messages, streaming, settle]);

  // Open at the requested message rather than the end. Runs after the effect
  // above in the same commit, so the end is never painted first.
  const targetId = target?.messageId;
  const targetKey = target ? `${target.messageId} ${target.key}` : null;
  useLayoutEffect(() => {
    if (!targetId || !targetKey || handledTarget.current === targetKey) return;
    const scroller = scrollRef.current;
    const element = findMessage(targetId);
    // An unknown message (deleted, or another conversation's) keeps the default.
    if (!scroller || !element) return;
    handledTarget.current = targetKey;

    measure();
    centre(element);
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    following.current = distance <= FOLLOW_THRESHOLD_PX;
    setDetached(!following.current);
    anchor.current = { messageId: targetId, until: performance.now() + TARGET_HOLD_MS };

    // Highlight briefly; the stylesheet swaps the fade for a still outline
    // under prefers-reduced-motion.
    element.setAttribute('data-search-target', '');
    const clearHighlight = window.setTimeout(
      () => element.removeAttribute('data-search-target'),
      TARGET_HIGHLIGHT_MS,
    );

    // Move focus to the message so screen readers continue from it. A closing
    // drawer or dialog can leave the view inert, or restore focus elsewhere,
    // for a frame or two, so retry briefly.
    if (!element.hasAttribute('tabindex')) element.setAttribute('tabindex', '-1');
    let attempts = 0;
    let frame = 0;
    const focus = () => {
      attempts += 1;
      if (!element.isConnected) return;
      if (!element.closest('[inert]')) element.focus({ preventScroll: true });
      if (document.activeElement !== element && attempts < FOCUS_ATTEMPTS) {
        frame = requestAnimationFrame(focus);
      }
    };
    frame = requestAnimationFrame(focus);

    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(clearHighlight);
      element.removeAttribute('data-search-target');
      // Lets a remount (or StrictMode's rehearsal) apply the same request again.
      handledTarget.current = null;
    };
  }, [targetId, targetKey, findMessage, measure, centre]);

  // The reader taking over ends the hold on a search match at once.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const release = () => {
      anchor.current = null;
    };
    const options = { passive: true } as const;
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const) {
      scroller.addEventListener(type, release, options);
    }
    return () => {
      for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const) {
        scroller.removeEventListener(type, release);
      }
    };
  }, []);

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
    anchor.current = null;
    following.current = true;
    setDetached(false);
    scrollToBottom();
  }, [scrollToBottom]);

  return { scrollRef, contentRef, spacerRef, onScroll, detached, jumpToLatest };
}
