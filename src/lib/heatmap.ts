export function rankValues(values: (number | null)[]): (number | null)[] {
  const sorted = [...new Set(values.filter((value): value is number => value !== null && Number.isFinite(value)))].sort((a, b) => a - b);
  const rank = new Map(sorted.map((value, index) => [value, sorted.length === 1 ? 0.5 : index / (sorted.length - 1)]));
  return values.map((value) => value === null || !Number.isFinite(value) ? null : rank.get(value) ?? null);
}
