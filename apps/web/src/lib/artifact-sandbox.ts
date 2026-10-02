import {
  ARTIFACT_LIBRARIES,
  ARTIFACT_LIBRARY_PATTERN,
  type ArtifactLibrary,
  requestedLibraries,
} from '@oci/shared';

/**
 * The sandbox HTML and SVG artifacts run in, here and on share links.
 *
 * - The frame is `sandbox="allow-scripts"` and nothing else: no
 *   `allow-same-origin` (its origin is opaque, so it cannot read OCI's
 *   cookies, storage or DOM, nor call the API with the person's session), no
 *   `allow-top-navigation` or `allow-popups` (a link cannot leave OCI or open
 *   a window), no `allow-forms`, `allow-modals` or `allow-downloads`.
 * - Its Content-Security-Policy allows inline scripts and styles and `data:`
 *   or `blob:` images and fonts only: no `connect-src`, `frame-src` or any
 *   other source, so it cannot fetch, open sockets or load anything.
 * - The few libraries offered are inlined by OCI from its own bundle; the frame
 *   never fetches them.
 *
 * The frame is a static host page (`/artifact-frame.html`, served with this
 * policy) that receives the document by `postMessage` and writes it. An
 * `srcdoc` frame would inherit the application's own policy (`script-src
 * 'self'`), which blocks every inline script; see docs/dev/v0.9-design.md.
 */
export const ARTIFACT_FRAME_SANDBOX = 'allow-scripts';
export const ARTIFACT_FRAME_URL = '/artifact-frame.html';
export const ARTIFACT_FRAME_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:";
/** Also refuses `<base>` and form targets; stricter than the policy above, never looser. */
export const ARTIFACT_DOCUMENT_CSP = `${ARTIFACT_FRAME_CSP}; base-uri 'none'; form-action 'none'`;

export const FRAME_READY = 'oci-artifact-ready';
export const FRAME_DOCUMENT = 'oci-artifact';

/**
 * Keeps ordinary link clicks inside the frame from navigating it away: a
 * frame cannot navigate OCI itself (no top navigation), but following a link
 * would replace the artifact. Same-document `#` links still work.
 */
const LINK_GUARD = `<script>document.addEventListener('click',function(e){var t=e.target,a=t&&t.closest?t.closest('a[href]'):null;if(a&&(a.getAttribute('href')||'').charAt(0)!=='#'){e.preventDefault();}},true);</script>`;

const BASE_STYLE =
  '<style>html{color-scheme:light}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}</style>';
const SVG_STYLE =
  '<style>html,body{height:100%;margin:0;background:#fff}body{display:flex;align-items:center;justify-content:center}body>svg{max-width:100%;max-height:100vh;height:auto}</style>';

/** Inline-script safe: a library can never end the script element early. */
export function inlineScript(source: string): string {
  return `<script>${source.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--')}</script>`;
}

/**
 * The document written into the frame. The policy is the first element of
 * the head, so it applies before any of the artifact's own markup; a policy
 * the artifact adds itself can only restrict further. Library markers become
 * the inlined library (or nothing, when unknown); automatic refreshes are
 * removed because they would navigate the frame.
 */
export function buildArtifactDocument(
  kind: 'html' | 'svg',
  content: string,
  libraries: Partial<Record<ArtifactLibrary, string>> = {},
): string {
  const head = [
    '<!doctype html><html><head>',
    `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_DOCUMENT_CSP}">`,
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    LINK_GUARD,
    kind === 'svg' ? SVG_STYLE : BASE_STYLE,
  ].join('');
  const body = content
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, '')
    .replace(ARTIFACT_LIBRARY_PATTERN, (_marker, name: string) => {
      const source = libraries[name.toLowerCase() as ArtifactLibrary];
      return source ? inlineScript(source) : '';
    });
  return kind === 'svg' ? `${head}</head><body>${body}</body></html>` : `${head}${body}`;
}

const LOADERS: Record<ArtifactLibrary, () => Promise<string>> = {
  // D3 (ISC licence), from OCI's own bundle; loaded only when an artifact asks.
  // A file path, because the package's `exports` do not list its browser build.
  d3: () => import('../../node_modules/d3/dist/d3.min.js?raw').then((module) => module.default),
};

/** The source of each library the content asks for, loaded on demand. */
export async function loadArtifactLibraries(
  content: string,
): Promise<Partial<Record<ArtifactLibrary, string>>> {
  const names = requestedLibraries(content).filter((name) => name in ARTIFACT_LIBRARIES);
  const sources = await Promise.all(names.map((name) => LOADERS[name]()));
  return Object.fromEntries(names.map((name, index) => [name, sources[index]]));
}
