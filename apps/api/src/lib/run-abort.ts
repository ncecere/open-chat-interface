/** Why a reply's run was stopped. */
export type RunStopKind = 'user-stop' | 'shutdown' | 'setup-failed';

const messages: Record<RunStopKind, string> = {
  'user-stop': 'The reply was stopped',
  shutdown: 'The server is shutting down',
  'setup-failed': 'The reply could not be set up',
};

/**
 * The reason a reply's AbortController is aborted with. It must be an
 * `AbortError`, not a bare string: fetch rejects an aborted response-body
 * read with the reason itself, and the AI SDK only treats an `AbortError` as a
 * stop. With a string reason a fetch-based provider (an OpenAI-compatible
 * gateway, as opposed to the test mocks) ended a stopped reply with an
 * "An error occurred." frame, `onEnd` never saw `isAborted`, and a reply cut
 * off by the drain limit or by Stop was saved as complete (#136).
 */
export class RunAbortReason extends DOMException {
  constructor(readonly kind: RunStopKind) {
    super(messages[kind], 'AbortError');
  }
}

export function runAbortReason(kind: RunStopKind): RunAbortReason {
  return new RunAbortReason(kind);
}

/** The stop kind a signal was aborted with, if it was one of ours. */
export function runStopKind(signal: AbortSignal): RunStopKind | undefined {
  return signal.aborted && signal.reason instanceof RunAbortReason ? signal.reason.kind : undefined;
}
