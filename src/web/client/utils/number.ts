/**
 * Parses an optional integer input only when it satisfies the supplied lower bound.
 * @param raw - Raw input value.
 * @param minimum - Inclusive lower bound for accepted values.
 * @returns The parsed integer, or `undefined` when the input is invalid.
 */
export function parseIntegerAtLeast(raw: string, minimum: number): number | undefined {
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(value) && value >= minimum ? value : undefined;
}
