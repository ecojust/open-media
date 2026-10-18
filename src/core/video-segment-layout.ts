import type { VideoSegmentTitleLayout } from './video-segment-presets.ts'

export interface VideoSegmentTextBox {
  x: number
  y: number
  width: number
  height: number
  fontSize: number
  textAlign: 'left' | 'center' | 'right'
}

/** Shared by real text clips and the library preview; all margins scale with the frame. */
export function videoSegmentTextLayout(width: number, height: number, layout: VideoSegmentTitleLayout = 'center', hasSubheading = true): { heading: VideoSegmentTextBox; subheading: VideoSegmentTextBox } {
  if (!['center', 'left', 'lower-third'].includes(layout)) throw new Error('片头片尾标题布局无效。')
  const basis = Math.min(width, height * 16 / 9)
  const box = (x: number, y: number, w: number, h: number, font: number, textAlign: VideoSegmentTextBox['textAlign']): VideoSegmentTextBox => ({
    x: width * x, y: height * y, width: width * w, height: height * h,
    fontSize: Math.max(4, Math.min(2048, basis * font)), textAlign,
  })
  if (layout === 'left') return {
    heading: box(.12, hasSubheading ? .34 : .36, .76, .27, .056, 'left'),
    subheading: box(.12, .23, .76, .10, .021, 'left'),
  }
  if (layout === 'lower-third') return {
    heading: box(.12, hasSubheading ? .60 : .66, .76, .20, .046, 'left'),
    subheading: box(.12, .81, .76, .10, .019, 'right'),
  }
  return {
    heading: box(.1, hasSubheading ? .36 : .4, .8, .22, .052, 'center'),
    subheading: box(.1, .555, .8, .12, .021, 'center'),
  }
}
