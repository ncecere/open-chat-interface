import { ARTIFACT_LIBRARIES, diagramAccent, type UserRole } from '@oci/shared';
import { roleFeatures } from '../role-features.js';
import { getSetting } from '../settings.js';
import { describeArtifact } from '../tools/artifacts.js';
import { artifactsForPrompt } from './store.js';

/**
 * Program code is an answer, not an artifact: people read, compare and copy it
 * in the reply, with the conversation's syntax highlighting, one block per file.
 */
export const PROGRAM_CODE_IN_CHAT =
  'Program code in any language (examples, functions, implementations, scripts, configuration) belongs in ordinary fenced code blocks in your reply, one block per language or file, never in an artifact, unless the person asks for an artifact.';

/** Whether the administrator left the Diagram Design guidance on (the default). */
async function diagramGuidanceEnabled(): Promise<boolean> {
  const chat = await getSetting('chat');
  return chat.diagramGuidance !== false;
}

const libraries = Object.entries(ARTIFACT_LIBRARIES)
  .map(
    ([name, library]) =>
      `<script data-oci-library="${name}"></script> for ${library.label} ${library.version} (global \`${library.global}\`)`,
  )
  .join(', ');

/**
 * Editorial diagram guidance, adapted in short from the Diagram Design skill
 * by Cathryn Lavery (MIT, https://github.com/cathrynlavery/diagram-design),
 * mapped to the instance's colour theme (see `diagramAccent`) and to fonts the
 * sandbox has offline.
 */
export function diagramGuidance(accent: string): string {
  return [
    'Diagrams: when a picture explains better than prose, draw it as an SVG artifact in an editorial style',
    '(adapted from Diagram Design by Cathryn Lavery, MIT).',
    'Every node is a distinct idea and every line carries information; delete what does not, and split anything over nine nodes.',
    `Use the accent ${accent} on one or two focal elements only; everything else ink #2d3142 and muted #4f5d75 on paper #f5f5f5,`,
    'with hairline borders and boxes at rx=6. Connectors are orthogonal (right-angle elbows with small rounded corners), drawn before the boxes;',
    'arrow labels are short, uppercase and sit on an opaque background.',
    'Names in a sans-serif font, technical labels (ports, URLs, types) in monospace, the title in a serif font; no web fonts.',
    'Give the <svg> role="img" with <title> and <desc> as its first children, and a viewBox so it scales.',
  ].join(' ');
}

/**
 * The system-prompt section shown when artifacts are available to the person:
 * how to make one, and (with the artifact tools) which ones exist. Empty when
 * the role's switch is off.
 */
export async function artifactGuidance(context: {
  role: UserRole;
  userId: string;
  threadId: string;
  /** The artifact tools are offered this turn. */
  tools: boolean;
}): Promise<string> {
  if (!(await roleFeatures(context.role)).artifacts) return '';
  const lines = [
    'Artifacts: content the person will want to see rendered, such as an HTML page or small app, an SVG image or diagram, or a Mermaid diagram,',
    'is shown to the person as an artifact they can open, preview, copy and download.',
    context.tools
      ? 'Create one with the create_artifact tool and revise it with update_artifact, preferring small find-and-replace edits; or write it as a single fenced code block (```html, ```svg or ```mermaid). Use a Markdown artifact only for a long prose document the person asked for, such as a report, letter or plan; tables, lists and short answers go in your reply, and anything you put in an artifact is not repeated in your reply.'
      : 'Write each one as a single fenced code block (```html, ```svg or ```mermaid); HTML should be a complete document.',
    PROGRAM_CODE_IN_CHAT,
    'Never link to an artifact in your text: a card for it appears below your reply on its own.',
    'Artifacts run in a sandbox without network access: inline all styles, scripts and images (no external URLs, fonts or requests).',
    `For charts, include ${libraries}.`,
  ];
  if (context.tools) {
    const existing = await artifactsForPrompt(context.threadId, context.userId);
    if (existing.length)
      lines.push(
        `Artifacts in this conversation: ${existing
          .map((artifact) => `${artifact.id} ${describeArtifact(artifact)}`)
          .join('; ')}.`,
      );
  }
  const sections = [lines.join(' ')];
  if (await diagramGuidanceEnabled()) {
    // Follows the Branding page's colour theme; an accentColor set through the
    // API (it is not on the page) overrides it.
    sections.push(diagramGuidance(diagramAccent(await getSetting('branding'))));
  }
  return sections.join('\n\n');
}
