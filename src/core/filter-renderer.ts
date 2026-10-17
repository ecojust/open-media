import { applyClipColorMatrix, getClipColorMatrix, isClipFilterIdentity, type ColorMatrix } from './clip-filters.ts'
import { applyChromaKey, chromaKeyColor, isChromaKeyEnabled } from './chroma-key.ts'
import type { ClipChromaKey, ClipFilters } from './types.ts'

export interface ClipFilterRendererOptions { preferCpu?: boolean; maxPixels?: number; maxDimension?: number }

interface GlResources {
  program: WebGLProgram
  buffer: WebGLBuffer
  texture: WebGLTexture
  position: number
  rows: [WebGLUniformLocation, WebGLUniformLocation, WebGLUniformLocation]
  sampler: WebGLUniformLocation
  keyColor: WebGLUniformLocation
  keySettings: WebGLUniformLocation
}

const VERTEX_SHADER = `
attribute vec2 position;
varying vec2 texCoord;
void main() {
  texCoord = (position + 1.0) * 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}`
const FRAGMENT_SHADER = `
precision highp float;
varying vec2 texCoord;
uniform sampler2D image;
uniform vec4 redRow;
uniform vec4 greenRow;
uniform vec4 blueRow;
uniform vec3 keyColor;
uniform vec3 keySettings;
void main() {
  vec4 source = texture2D(image, texCoord);
  vec4 color = vec4(source.rgb, 1.0);
  vec3 result = vec3(dot(redRow, color), dot(greenRow, color), dot(blueRow, color));
  float alpha = source.a;
  if (keySettings.x > 0.5) {
    float distance = length(source.rgb - keyColor) / sqrt(3.0);
    float mask = keySettings.z > 0.0001 ? clamp((distance - keySettings.y) / keySettings.z, 0.0, 1.0) : float(distance > keySettings.y);
    alpha *= mask;
  }
  gl_FragColor = vec4(clamp(result, 0.0, 1.0), alpha);
}`

/** Reuses its canvases; consume each result before rendering the next clip. */
export class ClipFilterRenderer {
  private canvas = document.createElement('canvas')
  private cpuCanvas = document.createElement('canvas')
  private cpuContext?: CanvasRenderingContext2D
  private gl?: WebGLRenderingContext
  private resources?: GlResources
  private initialized = false
  private lost = false
  private disposed = false
  private preferCpu: boolean
  private maxPixels: number
  private maxDimension: number
  private lastBackend: 'webgl' | 'cpu' = 'cpu'

  constructor(options: ClipFilterRendererOptions = {}) {
    this.preferCpu = options.preferCpu ?? false
    this.maxPixels = Number.isFinite(options.maxPixels) && options.maxPixels! >= 1 ? Math.floor(options.maxPixels!) : 8_294_400
    this.maxDimension = Number.isFinite(options.maxDimension) && options.maxDimension! >= 1 ? Math.floor(options.maxDimension!) : 4096
    this.canvas.addEventListener('webglcontextlost', this.contextLost)
    this.canvas.addEventListener('webglcontextrestored', this.contextRestored)
  }

  get backend(): 'webgl' | 'cpu' { return this.lastBackend }

  private contextLost = (event: Event): void => {
    event.preventDefault()
    this.lost = true
    this.resources = undefined
  }

  private contextRestored = (): void => {
    if (this.disposed) return
    this.lost = false
    this.initialized = false
    this.gl = undefined
  }

  private initializeGl(): void {
    if (this.initialized || this.preferCpu || this.lost) return
    this.initialized = true
    const gl = this.canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false, depth: false, stencil: false })
    if (!gl) return
    this.gl = gl
    const shaders: WebGLShader[] = []
    let program: WebGLProgram | null = null
    let buffer: WebGLBuffer | null = null
    let texture: WebGLTexture | null = null
    try {
      const compile = (type: number, source: string) => {
        const shader = gl.createShader(type)
        if (!shader) throw new Error('滤镜着色器不可用。')
        shaders.push(shader)
        gl.shaderSource(shader, source)
        gl.compileShader(shader)
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('滤镜着色器不可用。')
        return shader
      }
      program = gl.createProgram()
      if (!program) throw new Error('滤镜渲染程序不可用。')
      gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SHADER))
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER))
      gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('滤镜渲染程序不可用。')
      const uniform = (name: string) => {
        const location = gl.getUniformLocation(program!, name)
        if (!location) throw new Error('滤镜渲染参数不可用。')
        return location
      }
      buffer = gl.createBuffer()
      texture = gl.createTexture()
      if (!buffer || !texture) throw new Error('滤镜渲染内存不足。')
      const position = gl.getAttribLocation(program, 'position')
      if (position < 0) throw new Error('滤镜渲染坐标不可用。')
      this.resources = { program, buffer, texture, position, rows: [uniform('redRow'), uniform('greenRow'), uniform('blueRow')], sampler: uniform('image'), keyColor: uniform('keyColor'), keySettings: uniform('keySettings') }
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    } catch {
      if (texture) gl.deleteTexture(texture)
      if (buffer) gl.deleteBuffer(buffer)
      if (program) gl.deleteProgram(program)
      this.resources = undefined
    } finally {
      for (const shader of shaders) gl.deleteShader(shader)
    }
  }

  private dimensions(targetWidth: number, targetHeight: number): [number, number] {
    const width = Math.max(1, targetWidth), height = Math.max(1, targetHeight)
    const scale = Math.min(1, this.maxDimension / width, this.maxDimension / height, Math.sqrt(this.maxPixels / (width * height)))
    return [Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale))]
  }

  private drawCpuSource(source: CanvasImageSource, sourceWidth: number, sourceHeight: number, width: number, height: number): CanvasRenderingContext2D {
    if (this.cpuCanvas.width !== width) this.cpuCanvas.width = width
    if (this.cpuCanvas.height !== height) this.cpuCanvas.height = height
    const context = this.cpuContext ?? this.cpuCanvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('当前环境无法渲染片段滤镜。')
    this.cpuContext = context
    context.clearRect(0, 0, width, height)
    context.drawImage(source, 0, 0, sourceWidth, sourceHeight, 0, 0, width, height)
    return context
  }

  private drawGl(source: CanvasImageSource, sourceWidth: number, sourceHeight: number, width: number, height: number, matrix: ColorMatrix, chromaKey?: ClipChromaKey): HTMLCanvasElement | undefined {
    this.initializeGl()
    const gl = this.gl, resources = this.resources
    if (!gl || !resources || this.lost || gl.isContextLost()) return
    try {
      const textureLimit = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
      const renderLimit = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number
      if (width > renderLimit || height > renderLimit) return
      let textureSource = source
      if (sourceWidth > textureLimit || sourceHeight > textureLimit) {
        this.drawCpuSource(source, sourceWidth, sourceHeight, width, height)
        textureSource = this.cpuCanvas
      }
      if (this.canvas.width !== width) this.canvas.width = width
      if (this.canvas.height !== height) this.canvas.height = height
      gl.viewport(0, 0, width, height)
      gl.useProgram(resources.program)
      gl.bindBuffer(gl.ARRAY_BUFFER, resources.buffer)
      gl.enableVertexAttribArray(resources.position)
      gl.vertexAttribPointer(resources.position, 2, gl.FLOAT, false, 0, 0)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, resources.texture)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, textureSource as TexImageSource)
      gl.uniform1i(resources.sampler, 0)
      for (let row = 0; row < 3; row++) gl.uniform4fv(resources.rows[row]!, new Float32Array(matrix.slice(row * 4, row * 4 + 4)))
      gl.uniform3fv(resources.keyColor, new Float32Array(chromaKey ? chromaKeyColor(chromaKey) : [0, 1, 0]))
      gl.uniform3f(resources.keySettings, isChromaKeyEnabled(chromaKey) ? 1 : 0, chromaKey?.similarity ?? 0.18, chromaKey?.blend ?? 0.08)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      if (gl.getError() !== gl.NO_ERROR || gl.isContextLost()) return
      this.lastBackend = 'webgl'
      return this.canvas
    } catch {
      // CPU applies the identical transform when texture uploads or GPU resources fail.
      return
    }
  }

  render(source: CanvasImageSource, sourceWidth: number, sourceHeight: number, targetWidth: number, targetHeight: number, filters?: ClipFilters, chromaKey?: ClipChromaKey): HTMLCanvasElement {
    if (this.disposed) throw new Error('片段滤镜渲染器已关闭。')
    if (![sourceWidth, sourceHeight, targetWidth, targetHeight].every(value => Number.isFinite(value) && value > 0)) throw new Error('片段滤镜画面尺寸无效。')
    const [width, height] = this.dimensions(targetWidth, targetHeight)
    const matrix = getClipColorMatrix(filters)
    const identity = isClipFilterIdentity(filters)
    const keyed = isChromaKeyEnabled(chromaKey)
    if (!identity || keyed) {
      const result = this.drawGl(source, sourceWidth, sourceHeight, width, height, matrix, chromaKey)
      if (result) return result
    }
    const context = this.drawCpuSource(source, sourceWidth, sourceHeight, width, height)
    if (!identity || keyed) {
      const image = context.getImageData(0, 0, width, height)
      if (keyed) applyChromaKey(image.data, chromaKey)
      if (!identity) applyClipColorMatrix(image.data, matrix)
      context.putImageData(image, 0, 0)
    }
    this.lastBackend = 'cpu'
    return this.cpuCanvas
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.canvas.removeEventListener('webglcontextlost', this.contextLost)
    this.canvas.removeEventListener('webglcontextrestored', this.contextRestored)
    if (this.gl && this.resources) {
      this.gl.deleteTexture(this.resources.texture)
      this.gl.deleteBuffer(this.resources.buffer)
      this.gl.deleteProgram(this.resources.program)
    }
    this.gl?.getExtension('WEBGL_lose_context')?.loseContext()
    this.resources = undefined
    this.gl = undefined
    this.cpuContext = undefined
    this.canvas.width = this.canvas.height = this.cpuCanvas.width = this.cpuCanvas.height = 1
  }
}
