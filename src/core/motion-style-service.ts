import type { EditorToolContext, PreparedEditorTool } from './editor-tool-service.ts'
import type { MediaAsset } from './types.ts'
import { MOTION_STYLES, getMotionStyle, type MotionStyle } from './motion-style-catalog.ts'
import { composeMotionProject, planMotionComposition, type MotionComposeOptions } from './motion-style-composer.ts'
import { assertProjectRevision } from './project-operations.ts'

export interface MotionStyleDependencies {
  renderArt: (styleId: string, palette: Partial<MotionStyle['palette']>, width: number, height: number) => Promise<{ background: Blob; decoration: Blob }>
  isDesktop: () => boolean
  importNative: (bytes: Uint8Array, name: string) => Promise<MediaAsset>
  importBrowser: (file: File) => Promise<MediaAsset>
  revokeAsset: (asset: MediaAsset) => void
}

async function defaults(): Promise<MotionStyleDependencies> {
  const [{ renderMotionStyleArt }, native, media] = await Promise.all([
    import('./motion-style-art.ts'), import('../native.ts'), import('./media-import.ts'),
  ])
  return { renderArt: renderMotionStyleArt, isDesktop: native.isDesktop, importNative: native.importBlobAsset, importBrowser: media.importMediaFile, revokeAsset: media.revokeMediaAsset }
}

function check(context: EditorToolContext): void {
  context.signal.throwIfAborted()
  context.assertCurrent?.()
}

/** Prepare owned artwork and editable tracks; the host alone commits the result. */
export async function prepareMotionStyleTool(name: string, args: Record<string, unknown>, context: EditorToolContext, dependencies?: MotionStyleDependencies): Promise<PreparedEditorTool> {
  check(context)
  assertProjectRevision(args.expectedRevision as number | undefined, context.revision)
  if (args.expectedProjectId !== undefined && args.expectedProjectId !== context.project.id) throw new Error('当前工程已经变化，请重新读取工程后操作。')
  if (name === 'open_media_motion_style_list') return { data: { items: structuredClone(MOTION_STYLES), total: MOTION_STYLES.length } }
  if (name !== 'open_media_motion_compose') throw new Error('未知风格成片工具。')
  const { dryRun, expectedRevision: _revision, expectedProjectId: _projectId, ...input } = args
  if (dryRun !== undefined && typeof dryRun !== 'boolean') throw new Error('预检查选项必须为布尔值。')
  context.onProgress({ stage: '正在检查素材与分镜安排', progress: 0 })
  const options = input as unknown as MotionComposeOptions
  const plan = planMotionComposition(context.project, options)
  check(context)
  if (dryRun) return { data: { ...plan, dryRun: true } }

  const deps = dependencies ?? await defaults()
  const assets: { asset: MediaAsset; blob: Blob }[] = []
  let accepted = false, discarded = false
  const discard = () => {
    if (accepted || discarded) return
    discarded = true
    for (const { asset } of assets) {
      deps.revokeAsset(asset)
      if (asset.sourceUrl?.startsWith('blob:') && asset.sourceUrl !== asset.url) URL.revokeObjectURL(asset.sourceUrl)
    }
  }
  try {
    check(context)
    context.onProgress({ stage: '正在绘制风格背景与装饰', progress: .15 })
    const art = await deps.renderArt(plan.styleId, plan.palette, context.project.width, context.project.height)
    check(context)
    const style = getMotionStyle(plan.styleId)
    for (const [key, label] of [['background', '背景'], ['decoration', '装饰']] as const) {
      const blob = art[key]
      if (!(blob instanceof Blob) || !blob.size || blob.type !== 'image/png') throw new Error(`风格${label}未能生成有效图片。`)
      check(context)
      context.onProgress({ stage: `正在准备风格${label}素材`, progress: key === 'background' ? .45 : .65 })
      const filename = `风格成片-${style.name}-${label}.png`
      let asset: MediaAsset
      if (deps.isDesktop()) {
        const bytes = new Uint8Array(await blob.arrayBuffer())
        check(context)
        asset = await deps.importNative(bytes, filename)
      } else asset = await deps.importBrowser(new File([blob], filename, { type: 'image/png' }))
      // Register ownership before checking cancellation: the import may finish after an abort.
      asset = { ...asset, libraryRole: 'motion-style' }
      assets.push({ asset, blob })
      check(context)
      if (asset.kind !== 'image' || !asset.id || !asset.url || !(asset.width > 0) || !(asset.height > 0)) throw new Error(`风格${label}图片导入失败。`)
    }
    context.onProgress({ stage: '正在编排可编辑图层与动画', progress: .85 })
    const result = composeMotionProject(context.project, options, { background: assets[0]!.asset, decoration: assets[1]!.asset })
    check(context)
    context.onProgress({ stage: '风格成片已准备完成', progress: 1 })
    check(context)
    return {
      ...result,
      data: { ...result.data, selection: result.selection, dryRun: false },
      label: `生成${style.name}风格成片`,
      assets,
      accept: async () => { if (!discarded) accepted = true },
      discard,
    }
  } catch (cause) { discard(); throw cause }
}
