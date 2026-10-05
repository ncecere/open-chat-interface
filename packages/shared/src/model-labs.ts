/**
 * Model lab catalog.
 *
 * Generated from the LobeHub icon set (MIT). Each entry names a lab and the
 * light/dark SVG marks served from `/logos`. Individual company logos may also
 * be governed by their owners' trademark and brand-use policies.
 *
 * The catalog data lives in `./model-labs/` (alphabetical chunks assembled by
 * `catalog.ts`); lookup helpers live in `./model-labs/lookup.ts`.
 *
 * Regenerate with `pnpm logos:sync`.
 */

export { MODEL_LABS } from './model-labs/catalog.js';
export { findModelLab, modelLabLogoUrl } from './model-labs/lookup.js';
export type { ModelLab } from './model-labs/types.js';
