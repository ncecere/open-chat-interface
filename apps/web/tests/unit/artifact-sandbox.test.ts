import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_DOCUMENT_CSP,
  ARTIFACT_FRAME_CSP,
  ARTIFACT_FRAME_SANDBOX,
  ARTIFACT_FRAME_URL,
  buildArtifactDocument,
  inlineScript,
  loadArtifactLibraries,
} from '../../src/lib/artifact-sandbox';

const caddyfile = readFileSync(new URL('../../../../docker/Caddyfile', import.meta.url), 'utf8');
const host = readFileSync(new URL('../../public/artifact-frame.html', import.meta.url), 'utf8');

describe('sandbox policy', () => {
  it('allows scripts only: no same origin, navigation, popups, forms or modals', () => {
    expect(ARTIFACT_FRAME_SANDBOX).toBe('allow-scripts');
    for (const flag of [
      'allow-same-origin',
      'allow-top-navigation',
      'allow-top-navigation-by-user-activation',
      'allow-popups',
      'allow-forms',
      'allow-modals',
      'allow-downloads',
    ])
      expect(ARTIFACT_FRAME_SANDBOX).not.toContain(flag);
  });

  it('blocks every network source', () => {
    expect(ARTIFACT_FRAME_CSP).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:",
    );
    for (const source of [
      'connect-src',
      'frame-src',
      'child-src',
      'http:',
      'https:',
      "'self'",
      '*',
    ])
      expect(ARTIFACT_DOCUMENT_CSP).not.toContain(source);
    expect(ARTIFACT_DOCUMENT_CSP).toContain("form-action 'none'");
    expect(ARTIFACT_DOCUMENT_CSP).toContain("base-uri 'none'");
  });

  it('serves the host page with the same policy, framed only by OCI itself', () => {
    expect(ARTIFACT_FRAME_URL).toBe('/artifact-frame.html');
    expect(host).toContain(`content="${ARTIFACT_DOCUMENT_CSP}"`);
    // It answers its parent only, and writes one document.
    expect(host).toContain('event.source !== window.parent');
    expect(host).toContain('if (written ||');
    // It writes nothing unless framed with an opaque origin, so opening it
    // directly or framing it without a sandbox cannot run code on OCI's origin.
    expect(host).toContain("if (window.parent === window || window.origin !== 'null') return;");
    const frameHeaders = caddyfile.slice(caddyfile.indexOf('header @artifactFrame'));
    // A CSP sandbox keeps the page opaque even if framed or opened without
    // the sandbox attribute.
    expect(frameHeaders).toContain(
      `Content-Security-Policy "sandbox allow-scripts; ${ARTIFACT_DOCUMENT_CSP}; frame-ancestors 'self'"`,
    );
    expect(frameHeaders).not.toContain('X-Frame-Options');
    // Everything else keeps the application policy, which forbids framing.
    expect(caddyfile).toContain('@application not path /artifact-frame.html');
    const appHeaders = caddyfile.slice(
      caddyfile.indexOf('header @application'),
      caddyfile.indexOf('header @artifactFrame'),
    );
    expect(appHeaders).toContain("frame-ancestors 'none'");
    expect(appHeaders).toContain('X-Frame-Options DENY');
  });
});

describe('artifact documents', () => {
  it('puts the policy first, before any of the artifact’s own markup', () => {
    const html = buildArtifactDocument(
      'html',
      '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body>Hi</body></html>',
    );
    const policy = html.indexOf(`content="${ARTIFACT_DOCUMENT_CSP}"`);
    expect(policy).toBeGreaterThan(0);
    expect(policy).toBeLessThan(html.indexOf('default-src *'));
    expect(html.indexOf('<meta')).toBe(
      policy - '<meta http-equiv="Content-Security-Policy" '.length,
    );
  });

  it('wraps SVG in a document and removes automatic refreshes', () => {
    const svg = buildArtifactDocument('svg', '<svg><circle r="1"/></svg>');
    expect(svg).toMatch(/<body><svg><circle r="1"\/><\/svg><\/body><\/html>$/);
    const html = buildArtifactDocument(
      'html',
      '<meta http-equiv="refresh" content="0;url=https://evil.test/?x">',
    );
    expect(html).not.toContain('evil.test');
  });

  it('keeps link clicks inside the frame', () => {
    const html = buildArtifactDocument('html', '<a href="https://example.test">x</a>');
    expect(html).toContain("addEventListener('click'");
    expect(html).toContain('preventDefault');
  });

  it('inlines requested libraries from OCI and drops unknown ones; never a URL', async () => {
    const content =
      '<script data-oci-library="d3"></script><script data-oci-library="leftpad"></script><p>x</p>';
    const libraries = await loadArtifactLibraries(content);
    expect(Object.keys(libraries)).toEqual(['d3']);
    expect(libraries.d3?.length).toBeGreaterThan(100_000);
    const html = buildArtifactDocument('html', content, libraries);
    expect(html).not.toContain('data-oci-library');
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).toContain('<p>x</p>');
    expect(await loadArtifactLibraries('<p>no libraries</p>')).toEqual({});
  });

  it('escapes a library so it cannot end its script element', () => {
    expect(inlineScript('a("</script><img>")<!--')).toBe(
      '<script>a("<\\/script><img>")<\\!--</script>',
    );
  });
});
