/** Runtime guards also protect settings written outside VS Code's schema UI. */
export function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
    ? value
    : fallback;
}

export function remoteIntervalSeconds(value: unknown): number {
  // Node timers overflow beyond a signed 32-bit millisecond delay.
  return boundedInteger(value, 0, 0, 2147483);
}

export function logLimit(value: unknown): number {
  return boundedInteger(value, 50, 1, 1000);
}

export function matchLayout(
  folder: string,
  layout: unknown,
  capture: unknown
): { name: string; path: string } | undefined {
  if (
    typeof layout !== "string" ||
    !layout ||
    !Number.isInteger(capture) ||
    typeof capture !== "number" ||
    capture < 1 ||
    capture > 100
  )
    return undefined;
  try {
    const matches = folder.match(new RegExp(`(^|/)(${layout})$`));
    if (matches?.[2] && matches[capture + 2])
      return { name: matches[capture + 2], path: matches[2] };
  } catch {
    // An invalid configured expression disables that layout, not the workflow.
  }
  return undefined;
}
