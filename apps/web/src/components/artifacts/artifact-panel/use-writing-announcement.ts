import { useEffect, useRef, useState } from 'react';
import type { PanelView } from './panel-helpers';

/** Announces when a source starts and finishes being written, never each token. */
export function useWritingAnnouncement(view: PanelView | null): string {
  const [message, setMessage] = useState('');
  const announced = useRef<{ id: string; finished: boolean } | null>(null);
  useEffect(() => {
    const current = announced.current;
    if (view?.type === 'draft') {
      const name = view.title ?? 'the artifact';
      if (view.writing && view.title && current?.id !== view.draft.toolCallId) {
        announced.current = { id: view.draft.toolCallId, finished: false };
        setMessage(`Writing ${view.title}…`);
      } else if (!view.writing && current?.id === view.draft.toolCallId && !current.finished) {
        current.finished = true;
        setMessage(
          view.draft.state === 'saved'
            ? `Finished writing ${name}.`
            : `Writing ${name} stopped before it was saved.`,
        );
      }
    } else if (view?.type === 'artifact' && current && !current.finished) {
      current.finished = true;
      setMessage(`Finished writing ${view.ref.title}.`);
    }
  }, [view]);
  return message;
}
