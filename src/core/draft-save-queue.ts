interface SaveJob<T, R> {
  key: string
  revision: number
  value: T
  promise: Promise<R>
  resolve: (value: R) => void
  reject: (cause: unknown) => void
}

/** Keep one active write and only the latest waiting revision of each project. */
export function createDraftSaveQueue<T, R>(write: (value: T) => Promise<R>) {
  let active: SaveJob<T, R> | undefined
  const pending: SaveJob<T, R>[] = []
  const idle: (() => void)[] = []

  function advance(): void {
    if (active) return
    const job = pending.shift()
    if (!job) { for (const resolve of idle.splice(0)) resolve(); return }
    active = job
    void Promise.resolve().then(() => write(job.value)).then(
      value => { job.resolve(value); active = undefined; advance() },
      cause => { job.reject(cause); active = undefined; advance() },
    )
  }

  return {
    save(key: string, revision: number, value: T): Promise<R> {
      const queued = pending.find(job => job.key === key)
      if (queued) {
        if (revision >= queued.revision) { queued.revision = revision; queued.value = value }
        return queued.promise
      }
      if (active?.key === key && active.revision === revision) return active.promise
      let resolve!: (value: R) => void, reject!: (cause: unknown) => void
      const promise = new Promise<R>((yes, no) => { resolve = yes; reject = no })
      pending.push({ key, revision, value, promise, resolve, reject })
      advance()
      return promise
    },
    flush(): Promise<void> {
      if (!active && !pending.length) return Promise.resolve()
      return new Promise(resolve => idle.push(resolve))
    },
  }
}

export function draftSaveErrorMessage(cause: unknown): string {
  const names = new Set<string>(), seen = new Set<object>()
  let current = cause
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    if ('name' in current) names.add(String(current.name))
    current = 'cause' in current ? current.cause : undefined
  }
  const detail = cause instanceof Error ? cause.message : String(cause)
  if (names.has('QuotaExceededError') || /quota|disk.*full|空间不足/i.test(detail)) {
    return '本地草稿存储空间不足。当前编辑仍在内存中，请先保存项目文件，再释放磁盘空间后重试。'
  }
  if (names.has('AbortError') || names.has('TransactionInactiveError')) {
    return `本地草稿写入中断，已保存的草稿未被替换。可继续编辑并点击重试。${detail ? `（${detail}）` : ''}`
  }
  return `${detail || '本地草稿暂时无法写入。'} 当前编辑仍在内存中，可先保存项目文件后重试草稿。`
}
