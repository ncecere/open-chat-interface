export type ChatRunStatus = 'active' | 'complete' | 'error' | 'cancelled';

export interface ChatRunIdentity {
  runId: string;
  threadId: string;
  userId: string;
}

export interface ChatRunOutcome {
  status: Exclude<ChatRunStatus, 'active'>;
  error?: string;
  replayUnavailable?: boolean;
}

export type BeginChatRunResult = 'available' | 'unavailable' | 'conflict';

/** Only a caller that has already acquired the durable assistant claim may use this. */
export interface BeginOptions {
  admission: 'durable';
}
