/** Build a stable comment target key from segments (e.g. scope, metric, date). */
export function commentTargetKey(...parts) {
  return parts.filter((p) => p != null && p !== '').join('|');
}
