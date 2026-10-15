import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

/** Modules of white around the code, as the QR standard asks, so scanners find its edge. */
const QUIET_ZONE = 4;

/**
 * A QR code drawn client-side as SVG (qrcode-generator, no network, nothing
 * sent anywhere): the authenticator link never leaves the page. Hidden from
 * assistive technology: the manual key and the link beside it are the accessible
 * way to the same secret (WCAG 2.2 SC 1.1.1, SC 3.3.8).
 *
 * Drawn as one path of unit squares, not through the library's `createSvgTag`,
 * so nothing is injected as markup. Fixed colours, black on white: some
 * scanners cannot read a code inverted for a dark theme.
 */
export function QrCode({ value, size = 192 }: { value: string; size?: number }) {
  const { path, modules } = useMemo(() => {
    // Type 0 picks the smallest version that fits; 'M' error correction (15%).
    const code = qrcode(0, 'M');
    code.addData(value, 'Byte');
    code.make();
    const count = code.getModuleCount();
    let d = '';
    for (let row = 0; row < count; row++)
      for (let col = 0; col < count; col++)
        if (code.isDark(row, col)) d += `M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`;
    return { path: d, modules: count };
  }, [value]);
  const extent = modules + 2 * QUIET_ZONE;
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={`0 0 ${extent} ${extent}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className="rounded-lg"
    >
      <rect width={extent} height={extent} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
