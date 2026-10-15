import { useEffect, useRef, useState } from 'react';
import { translate } from '~/lib/i18n';
import type { PanelView } from './panel-helpers';

/** Announces when a source starts and finishes being written, never each token. */
export function useWritingAnnouncement(view: PanelView | null): string {
  const [message, setMessage] = useState('');
  const announced = useRef<{ id: string; finished: boolean } | null>(null);
  useEffect(() => {
    const current = announced.current;
    if (view?.type === 'draft') {
      if (view.writing && view.title && current?.id !== view.draft.toolCallId) {
        announced.current = { id: view.draft.toolCallId, finished: false };
        setMessage(translate('chat.work.writingTitled', { title: view.title }));
      } else if (!view.writing && current?.id === view.draft.toolCallId && !current.finished) {
        current.finished = true;
        setMessage(
          view.draft.state === 'saved'
            ? view.title
              ? translate('artifacts.announce.finishedTitled', { title: view.title })
              : translate('artifacts.announce.finished')
            : view.title
              ? translate('artifacts.announce.stoppedTitled', { title: view.title })
              : translate('artifacts.announce.stopped'),
        );
      }
    } else if (view?.type === 'artifact' && current && !current.finished) {
      current.finished = true;
      setMessage(translate('artifacts.announce.finishedTitled', { title: view.ref.title }));
    }
  }, [view]);
  return message;
}
