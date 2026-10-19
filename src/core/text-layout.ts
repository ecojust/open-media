type TextLine = { text: string; metrics?: TextMetrics }

/** Keep measurement separate from painting so moving/fading text reuses its layout. */
export function measureTextLayout(context: CanvasRenderingContext2D, text: string, maxWidth: number, withMetrics: boolean): TextLine[] {
  const lines: TextLine[] = []
  const append = (line: string) => lines.push({ text: line, ...(withMetrics && line.trim() ? { metrics: context.measureText(line) } : {}) })
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const char of paragraph) {
      if (line && context.measureText(line + char).width > maxWidth) { append(line); line = char }
      else line += char
    }
    append(line)
  }
  return lines
}

/** A renderer owns one bounded cache; no video frames or canvas textures are retained. */
export class TextLayoutCache {
  private context?: CanvasRenderingContext2D
  private entries = new Map<string, { lines: TextLine[]; characters: number }>()
  private characters = 0
  private fonts?: FontFaceSet
  private fontFaces: FontFace[] = []
  private fontSignature = ''
  private clear = () => { this.entries.clear(); this.characters = 0 }

  constructor() {
    this.fonts = typeof document === 'undefined' ? undefined : document.fonts
    this.fonts?.addEventListener('loadingdone', this.clear)
    this.fonts?.addEventListener('loadingerror', this.clear)
  }

  private refreshFonts(): boolean {
    if (!this.fonts) return true
    // Adding an already-loaded face does not fire loadingdone. Compare both
    // identity and descriptors, including replacement with the same face count.
    const faces = [...this.fonts]
    const signature = JSON.stringify(faces.map(face => {
      const extended = face as FontFace & { sizeAdjust?: string; variationSettings?: string }
      return [face.family, face.style, face.weight, face.stretch, face.unicodeRange, face.featureSettings,
        face.ascentOverride, face.descentOverride, face.lineGapOverride, extended.sizeAdjust, extended.variationSettings, face.status]
    }))
    if (signature !== this.fontSignature || faces.length !== this.fontFaces.length || faces.some((face, index) => face !== this.fontFaces[index])) {
      this.clear(); this.fontSignature = signature; this.fontFaces = faces
    }
    // Font metrics can change during loading before the final completion event.
    return this.fonts.status !== 'loading'
  }

  get(context: CanvasRenderingContext2D, text: string, maxWidth: number, withMetrics: boolean): TextLine[] {
    if (context !== this.context) { this.clear(); this.context = context }
    const ready = this.refreshFonts()
    const key = JSON.stringify([text, maxWidth, withMetrics, context.font, context.textAlign, context.textBaseline,
      context.direction, context.fontKerning, context.fontStretch, context.fontVariantCaps,
      context.letterSpacing, context.wordSpacing, context.textRendering])
    if (ready) {
      const existing = this.entries.get(key)
      if (existing) { this.entries.delete(key); this.entries.set(key, existing); return existing.lines }
    }
    const lines = measureTextLayout(context, text, maxWidth, withMetrics)
    // Bound both object count and stored text. Huge editable captions still work
    // but do not evict the renderer into an unbounded text-history cache.
    if (ready && key.length <= 131072) {
      while (this.entries.size >= 128 || this.characters + key.length > 131072) {
        const oldest = this.entries.keys().next().value!
        this.characters -= this.entries.get(oldest)!.characters
        this.entries.delete(oldest)
      }
      this.entries.set(key, { lines, characters: key.length }); this.characters += key.length
    }
    return lines
  }

  dispose(): void {
    this.fonts?.removeEventListener('loadingdone', this.clear)
    this.fonts?.removeEventListener('loadingerror', this.clear)
    this.clear(); this.context = undefined; this.fontFaces = []
  }
}
