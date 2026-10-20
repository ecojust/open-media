/** A named file fills only an empty or untouched project name. */
export function withProjectFileTitle<T>(project: T, fileName?: string): T {
  if (!fileName || !project || typeof project !== 'object' || Array.isArray(project)) return project
  const value = project as Record<string, unknown>
  if (typeof value.title !== 'string' || (value.title.trim() && value.title.trim() !== '未命名项目')) return project
  const title = fileName.split(/[\\/]/).pop()?.replace(/\.omedia$/i, '').trim().slice(0, 300)
  return title ? { ...value, title } as T : project
}
