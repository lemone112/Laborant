/**
 * @module pipeline/cove/workflow
 * @deprecated Import from `./verify.js` instead. This file is kept for
 *   backward compatibility and will be removed in a future version.
 *
 * This module was renamed to `verify.ts` because it is NOT a Temporal workflow —
 * it is a pure async function called from inside a Temporal Activity.
 */
export { runCoVe } from './verify.js';
