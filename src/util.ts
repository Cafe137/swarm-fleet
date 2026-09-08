/**
 * Drops keys whose value is `undefined`.
 *
 * `exactOptionalPropertyTypes` distinguishes "absent" from "present and
 * undefined", so spreading a partial override straight onto a fully-specified
 * default would reintroduce `undefined` where a number is required. The return
 * type strips `undefined` as well as dropping the keys.
 */
export type Defined<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

export function defined<T extends Record<string, unknown>>(input: T): Defined<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as Defined<T>;
}
