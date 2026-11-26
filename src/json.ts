/**
 * Safe readers for parsed GitHub responses. They are untrusted input, so
 * every read checks own properties only (no walking the prototype chain) and
 * every value is type-checked before use.
 */

export type JsonObject = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Nested own-property lookup; `undefined` as soon as the path leaves an object. */
export function at(value: unknown, ...path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, key)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

/** A string value, or undefined. An empty string is returned as is. */
export function str(value: unknown, ...path: string[]): string | undefined {
  const found = at(value, ...path);
  return typeof found === "string" ? found : undefined;
}

/** A non-blank string value, or undefined. */
export function nonEmpty(value: unknown, ...path: string[]): string | undefined {
  const found = str(value, ...path);
  return found !== undefined && found.trim() !== "" ? found : undefined;
}

/**
 * An identifier sent either as a string or as a JSON integer.
 * Returned as a string. Blank strings and non-integers are rejected.
 */
export function idOf(value: unknown, ...path: string[]): string | undefined {
  const found = at(value, ...path);
  if (typeof found === "string") {
    return found.trim() === "" ? undefined : found;
  }
  if (typeof found === "number" && Number.isSafeInteger(found)) {
    return String(found);
  }
  return undefined;
}
