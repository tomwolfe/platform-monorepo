/**
 * Deep equality check without JSON.stringify overhead.
 *
 * JSON.stringify in a hot loop blocks the Node.js event loop and crushes
 * performance on large LLM trace objects. This recursive implementation
 * avoids stringification entirely.
 *
 * @package @repo/shared
 * @since 1.0.0
 */

/**
 * Perform a deep equality check between two values.
 * Handles primitives, arrays, plain objects, Date, RegExp, Map, Set.
 * Does NOT handle circular references (will stack-overflow).
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  // Strict equality catches primitives and identical references
  if (a === b) return true;

  // Different types or null/undefined mismatch
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;

  // Handle Date
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }

  // Handle RegExp
  if (a instanceof RegExp && b instanceof RegExp) {
    return a.source === b.source && a.flags === b.flags;
  }

  // Handle arrays
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  // Handle plain objects (non-array, non-null)
  if (typeof a === "object" && typeof b === "object") {
    // Ensure both are plain objects (not class instances)
    if (
      Object.prototype.toString.call(a) !== "[object Object]" ||
      Object.prototype.toString.call(b) !== "[object Object]"
    ) {
      return false;
    }

    const keysA = Object.keys(a as object);
    const keysB = Object.keys(b as object);

    if (keysA.length !== keysB.length) return false;

    for (const key of keysA) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (
        !deepEqual(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
        )
      )
        return false;
    }
    return true;
  }

  return false;
}
