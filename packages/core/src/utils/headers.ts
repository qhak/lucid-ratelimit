export function makeRateLimitHeaders(
  limit: number,
  remaining: number,
  resetAtMs: number,
  nowMs: number,
  retryAfterSeconds: number,
  legacy: boolean,
  success: boolean,
): Record<string, string> {
  const resetDelay = Math.max(0, Math.ceil((resetAtMs - nowMs) / 1_000));
  const headers: Record<string, string> = {
    'RateLimit-Limit': String(limit),
    'RateLimit-Remaining': String(Math.max(0, remaining)),
    'RateLimit-Reset': String(resetDelay),
  };
  if (!success) headers['Retry-After'] = String(Math.max(0, retryAfterSeconds));
  if (legacy) {
    headers['X-RateLimit-Limit'] = String(limit);
    headers['X-RateLimit-Remaining'] = String(Math.max(0, remaining));
    headers['X-RateLimit-Reset'] = String(Math.ceil(resetAtMs / 1_000));
  }
  return headers;
}
