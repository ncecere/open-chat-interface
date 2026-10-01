import type { DiagramPlugin } from 'streamdown';

type MermaidModule = typeof import('mermaid')['default'];
type MermaidConfig = Parameters<MermaidModule['initialize']>[0];

/**
 * Mermaid rendering for chat and public shares, styled after Diagram Design
 * (https://github.com/cathrynlavery/diagram-design, MIT): flat shapes with no
 * shadows, hairline strokes, quiet connectors, monospace edge labels, and the
 * instance accent reserved for a node the author marks with `:::focus`.
 *
 * Mermaid is large, so it loads only when a diagram is first rendered. The
 * colours come from the live theme tokens at that moment, so a diagram matches
 * the light or dark theme and the instance accent it appears in.
 */
let loader: Promise<MermaidModule> | null = null;
const loadMermaid = () => {
  loader ??= import('mermaid').then((module) => module.default);
  return loader;
};

/**
 * Theme tokens may use colour spaces Mermaid cannot parse (OKLCH). Painting
 * the colour onto a one-pixel canvas converts it to sRGB.
 */
function cssColor(variable: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  if (!value) return fallback;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return fallback;
  context.fillStyle = fallback;
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
  return `rgb(${red}, ${green}, ${blue})`;
}

function withAlpha(rgb: string, alpha: number): string {
  return rgb.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`);
}

function cssFont(variable: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(variable).trim() || fallback;
}

/** The editorial theme, resolved against the current page theme. */
export function editorialMermaidConfig(): MermaidConfig {
  const dark = document.documentElement.classList.contains('dark');
  const paper = cssColor('--bg-app', dark ? '#141414' : '#f7f7f7');
  const surface = cssColor('--bg-elevated', dark ? '#1f1f1f' : '#ffffff');
  const ink = cssColor('--text-primary', dark ? '#f5f5f5' : '#1f1f1f');
  const muted = cssColor('--text-muted', dark ? '#9a9a9a' : '#737373');
  const rule = cssColor('--border-strong', dark ? '#4a4a4a' : '#d4d4d4');
  const accent = cssColor('--accent-bright', dark ? '#f08a59' : '#eb6c36');
  const sans = cssFont('--font-sans', 'ui-sans-serif, system-ui, sans-serif');
  const mono = cssFont('--font-mono', 'ui-monospace, monospace');

  return {
    startOnLoad: false,
    // Diagrams come from model output and appear on public shares: no HTML
    // labels, no click handlers, no scripts.
    securityLevel: 'strict',
    theme: 'base',
    fontFamily: sans,
    themeVariables: {
      darkMode: dark,
      background: paper,
      fontFamily: sans,
      fontSize: '13px',
      primaryColor: surface,
      primaryTextColor: ink,
      primaryBorderColor: rule,
      secondaryColor: paper,
      secondaryTextColor: ink,
      secondaryBorderColor: rule,
      tertiaryColor: paper,
      tertiaryTextColor: ink,
      tertiaryBorderColor: rule,
      lineColor: muted,
      textColor: ink,
      mainBkg: surface,
      nodeBorder: rule,
      clusterBkg: paper,
      clusterBorder: rule,
      titleColor: ink,
      edgeLabelBackground: paper,
      noteBkgColor: paper,
      noteTextColor: ink,
      noteBorderColor: rule,
      actorBkg: surface,
      actorBorder: rule,
      actorTextColor: ink,
      actorLineColor: muted,
      signalColor: muted,
      signalTextColor: ink,
      labelBoxBkgColor: paper,
      labelBoxBorderColor: rule,
      labelTextColor: ink,
    },
    themeCSS: `
      .node rect, .node polygon, .node circle, .node ellipse, .node path,
      .cluster rect, .actor, .note, rect.task { stroke-width: 1px !important; filter: none !important; }
      .node rect, .cluster rect { rx: 4px; ry: 4px; }
      .edgePath path, .flowchart-link, .messageLine0, .messageLine1, .relation { stroke-width: 1px !important; }
      .edgeLabel, .edgeLabel p, .edgeLabel span, .messageText, .labelText, .loopText {
        font-family: ${mono}; font-size: 11px; letter-spacing: 0.02em; color: ${muted}; fill: ${muted};
      }
      .cluster-label, .cluster-label span { font-family: ${mono}; font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em; fill: ${muted}; color: ${muted}; }
      .node.focus rect, .node.focus polygon, .node.focus circle, .node.focus path {
        stroke: ${accent} !important; fill: ${withAlpha(accent, 0.12)} !important;
      }
      .node.focus .nodeLabel, .node.focus text { color: ${ink}; fill: ${ink}; font-weight: 600; }
    `,
  };
}

/** A Streamdown diagram plugin whose Mermaid loads on first use. */
export function createEditorialMermaidPlugin(): DiagramPlugin {
  const instance = {
    // Streamdown passes its own options here; the editorial config always wins
    // and is resolved per render so theme changes apply to new diagrams.
    initialize: () => {},
    async render(id: string, source: string) {
      const mermaid = await loadMermaid();
      mermaid.initialize(editorialMermaidConfig());
      return mermaid.render(id, source);
    },
  };
  return {
    name: 'mermaid',
    type: 'diagram',
    language: 'mermaid',
    getMermaid: () => instance,
  };
}
