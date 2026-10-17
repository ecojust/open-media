/** Editing retains unbounded source positions; only decoding wraps to the source. */
export function audioSourceTime(sourceTime: number, duration: number): number {
  if (!(duration > 0) || !Number.isFinite(duration)) return sourceTime
  return ((sourceTime % duration) + duration) % duration
}

/** Near a loop boundary, the end and beginning refer to adjacent samples. */
export function audioSourceDistance(first: number, second: number, duration: number): number {
  const distance = Math.abs(first - second)
  return duration > 0 && Number.isFinite(duration) ? Math.min(distance, Math.abs(duration - distance)) : distance
}
