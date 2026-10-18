import { createWorker, OEM, PSM, type Worker } from 'tesseract.js'
import workerPath from 'tesseract.js/dist/worker.min.js?url'
import corePath from 'tesseract.js-core/tesseract-core-lstm.wasm.js?url'
import type { EditorToolRunOptions } from './editor-tool-service.ts'

export interface OcrBox { x: number; y: number; width: number; height: number }
export interface OcrTextRegion { text: string; confidence: number; bounds: OcrBox }
export interface OcrResult {
  text: string
  confidence: number
  language: 'zh-en' | 'en'
  lines: OcrTextRegion[]
  words: OcrTextRegion[]
  coordinateSpace: 'image-pixels'
}

/** The worker, recognition core, and both language models are bundled locally. */
export async function recognizeImageText(image: Blob | HTMLCanvasElement, language: 'zh-en' | 'en', options: EditorToolRunOptions): Promise<OcrResult> {
  options.signal.throwIfAborted()
  let worker: Worker | undefined
  let aborted = false
  const onAbort = () => { aborted = true; void worker?.terminate() }
  options.signal.addEventListener('abort', onAbort, { once: true })
  const stages: Record<string, string> = {
    'loading tesseract core': '正在准备文字识别引擎',
    'initializing tesseract': '正在初始化文字识别',
    'loading language traineddata': '正在加载本地语言模型',
    'initializing api': '正在准备识别参数',
    'recognizing text': '正在识别画面文字',
  }
  try {
    worker = await createWorker(language === 'en' ? 'eng' : 'chi_sim+eng', OEM.LSTM_ONLY, {
      workerPath: new URL(workerPath, window.location.href).href,
      corePath: new URL(corePath, window.location.href).href,
      langPath: new URL('/ocr', window.location.href).href,
      workerBlobURL: false,
      cacheMethod: 'none',
      gzip: true,
      logger: update => {
        if (!aborted) options.onProgress({ stage: stages[update.status] ?? '正在准备文字识别', progress: update.status === 'recognizing text' ? .2 + update.progress * .8 : undefined })
      },
    })
    options.signal.throwIfAborted()
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT, preserve_interword_spaces: '1' })
    const pending = worker.recognize(image, {}, { text: true, blocks: true })
    const result = await new Promise<Awaited<typeof pending>>((resolve, reject) => {
      const abort = () => reject(new DOMException('文字识别已取消。', 'AbortError'))
      options.signal.addEventListener('abort', abort, { once: true })
      if (options.signal.aborted) abort()
      pending.then(resolve, reject).finally(() => options.signal.removeEventListener('abort', abort))
    })
    options.signal.throwIfAborted()
    const region = (value: { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }): OcrTextRegion => ({
      text: value.text.trim(), confidence: Math.max(0, Math.min(1, value.confidence / 100)),
      bounds: { x: value.bbox.x0, y: value.bbox.y0, width: value.bbox.x1 - value.bbox.x0, height: value.bbox.y1 - value.bbox.y0 },
    })
    const lines = (result.data.blocks ?? []).flatMap(block => block.paragraphs.flatMap(paragraph => paragraph.lines))
    options.onProgress({ stage: '文字识别完成', progress: 1 })
    return { text: result.data.text.trim(), confidence: Math.max(0, Math.min(1, result.data.confidence / 100)), language,
      lines: lines.map(region).filter(item => item.text), words: lines.flatMap(line => line.words.map(region)).filter(item => item.text), coordinateSpace: 'image-pixels' }
  } catch (cause) {
    if (options.signal.aborted) throw new DOMException('文字识别已取消。', 'AbortError')
    throw cause
  } finally {
    options.signal.removeEventListener('abort', onAbort)
    await worker?.terminate()
  }
}
