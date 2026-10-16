export const buildInfo = Object.freeze({
  version: __APP_VERSION__,
  builtAt: __APP_BUILD_TIME__,
  development: import.meta.env.DEV,
})

export function formatBuildTime(timestamp: string): string {
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return '时间不可用'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZoneName: 'shortOffset',
  }).format(date)
}
