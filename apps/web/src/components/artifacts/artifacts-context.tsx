import type { ArtifactKind } from '@oci/shared';
import { createContext, type ReactNode, useContext } from 'react';
import type { MarkdownProps } from '~/components/chat/markdown';

/** What a card needs to show an artifact and the panel needs to open it. */
export interface ArtifactRef {
  /** Null on share links: anonymous viewers never address artifacts by id. */
  id: string | null;
  messageId: string;
  sourceKey: string;
  title: string;
  kind: ArtifactKind;
  version: number;
  /** Given on share links, where the panel shows this one version only. */
  content?: string;
  /** Open the panel on this version rather than the current one. */
  openVersion?: number;
}

export interface ArtifactsContextValue {
  find: (messageId: string, sourceKey: string) => ArtifactRef | undefined;
  findById: (id: string) => ArtifactRef | undefined;
  /** Every artifact a reply created, in order. */
  forMessage: (messageId: string) => ArtifactRef[];
  open: (artifact: ArtifactRef) => void;
  /**
   * Open the panel on an artifact tool call of a reply, showing its source as
   * it is written; it switches to the saved artifact once there is one.
   * Conversations only.
   */
  openDraft?: (messageId: string, toolCallId: string) => void;
  /** True when the panel is docked beside the conversation rather than a dialog. */
  docked?: boolean;
  /** `owner`: versions, edits and the API; `public`: one version, read-only. */
  mode: 'owner' | 'public';
  /** Whether the person may edit documents (their role allows artifacts). */
  canEdit: boolean;
  /** Extra Markdown safety for public pages (no raw HTML, safe links only). */
  markdownProps?: Pick<MarkdownProps, 'skipHtml' | 'urlTransform'>;
}

const ArtifactsContext = createContext<ArtifactsContextValue | null>(null);

export function ArtifactsContextProvider({
  value,
  children,
}: {
  value: ArtifactsContextValue;
  children: ReactNode;
}) {
  return <ArtifactsContext.Provider value={value}>{children}</ArtifactsContext.Provider>;
}

/** Null outside a conversation or share page: replies then render exactly as before. */
export function useArtifacts(): ArtifactsContextValue | null {
  return useContext(ArtifactsContext);
}
