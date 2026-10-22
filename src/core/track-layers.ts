import type { Project } from './types.ts'

/** Array order is the single layer order: zero is the bottom, larger indices draw above it. */
export function trackZIndex(project: Pick<Project, 'tracks'>, trackId: string): number {
  return project.tracks.findIndex(track => track.id === trackId)
}
