// Modified by Memlia in 2026. Upstream Apache-2.0 license and notices retained.
import { createCanvas } from '@napi-rs/canvas'

/**
 * The brandbook cover template, rendered on demand.
 *
 * One template backs every social card the site generates: light gray field,
 * the "sim" wordmark top-left, a diagonal open arrow top-right, and the title
 * set large at the bottom-left. Library post covers are the build-time
 * rendering of it (`scripts/generate-library-covers.tsx`), docs pages the
 * edge-runtime one (`apps/docs/app/api/og/route.tsx`). This is the Node
 * rendering, for `apps/sim` routes that resolve their title per request.
 */

const COVER_WIDTH = 1200
const COVER_HEIGHT = 675

/** Exact hex from a vector trace of the reference cover template, not an estimate off compressed JPEG pixels. */
const INK_COLOR = '#515151'
const BACKGROUND_COLOR = '#c1c1c1'
/** The title's ink, dropped back so a secondary line reads as caption rather than headline. */
const MUTED_INK_COLOR = 'rgba(81, 81, 81, 0.72)'

/** Tried largest-first; the first size whose title wraps within `COVER_MAX_TITLE_LINES` wins. */
const TITLE_FONT_SIZES = [110, 96, 85] as const
const SUBTITLE_FONT_SIZE = 30
/**
 * How far the title is nudged down to swallow the invisible leading Satori
 * adds below its last line instead of splitting it evenly.
 */
/** Intended optical gap between the title's baseline row and the caption. */
const CAPTION_GAP = 18
const ELLIPSIS = '\u2026'
/** Width the title and its caption are laid out into, leaving the right third of the card open. */
export const COVER_TITLE_BOX_WIDTH = 1020
/**
 * Titles here are file names a viewer chose, so nothing upstream bounds their
 * length. Past three lines the block runs off the bottom of the fixed canvas
 * and reads as a paragraph rather than a headline, so the layout steps the
 * type down and then truncates rather than growing.
 */
export const COVER_MAX_TITLE_LINES = 3
/**
 * Captions run from one-line provenance up to a full catalog description, so
 * they wrap — but two lines is the ceiling. A third turns the block into a
 * paragraph competing with the title for the eye, which is the balance the
 * reference template is built around.
 */
export const COVER_MAX_CAPTION_LINES = 2

// Temporary native system typography; no font is read from the source tree or network.
const measureContext = createCanvas(1, 1).getContext('2d')

/** Whether `text` fits the title box at `fontSize`, by the font's real advance widths. */
function fits(text: string, fontSize: number): boolean {
  measureContext.font = `500 ${fontSize}px sans-serif`
  return measureContext.measureText(text).width <= COVER_TITLE_BOX_WIDTH
}

/** Trims `text` from the right until it plus an ellipsis fits the title box at `fontSize`. */
function withEllipsis(text: string, fontSize: number): string {
  let kept = text
  while (kept && !fits(kept + ELLIPSIS, fontSize)) {
    kept = kept.slice(0, -1)
  }
  return kept + ELLIPSIS
}

/** Greedily packs `pieces` into chunks that each fit the title box at `fontSize`. */
function packChunks(pieces: string[], fontSize: number): string[] {
  const chunks: string[] = []
  let chunk = ''

  for (const piece of pieces) {
    const candidate = chunk + piece
    if (!fits(candidate, fontSize) && chunk) {
      chunks.push(chunk)
      chunk = piece
    } else {
      chunk = candidate
    }
  }
  if (chunk) chunks.push(chunk)

  return chunks
}

/**
 * Splits a single word wider than the title box into chunks that each fit.
 *
 * Hyphens are tried first because that is where a reader expects a compound to
 * break, and the trailing hyphen stays on the upper line. A chunk with no
 * usable hyphen falls back to a character-level split — which file names, the
 * titles this renders, reach constantly.
 */
function splitOversizedWord(word: string, fontSize: number): string[] {
  const afterHyphens = packChunks(word.split(/(?<=-)/), fontSize)

  return afterHyphens.flatMap((chunk) =>
    fits(chunk, fontSize) ? [chunk] : packChunks([...chunk], fontSize)
  )
}

/**
 * Greedily packs words into lines that fit `COVER_TITLE_BOX_WIDTH` at
 * `fontSize`, joining them with U+00A0 rather than a plain space.
 *
 * Satori has a text-measurement bug where the first plain space (U+0020) in a
 * text node renders at roughly double width; a non-breaking space measures
 * correctly and reads identically at these sizes, so this sidesteps the bug
 * rather than fighting Satori's own line-wrapping, which is disabled here
 * since lines arrive pre-split. The U+00A0 goes in as the line is packed, so
 * what gets measured is exactly what gets rendered.
 */
function wrapLines(text: string, fontSize: number): string[] {
  const lines: string[] = []
  let current = ''

  for (const word of text.split(' ')) {
    if (!fits(word, fontSize)) {
      if (current) {
        lines.push(current)
        current = ''
      }
      const chunks = splitOversizedWord(word, fontSize)
      lines.push(...chunks.slice(0, -1))
      current = chunks[chunks.length - 1] ?? ''
      continue
    }

    const candidate = current ? `${current}\u00a0${word}` : word
    if (!fits(candidate, fontSize) && current) {
      lines.push(current)
      current = word
    } else {
      current = candidate
    }
  }
  if (current) lines.push(current)

  return lines
}

export const COVER_OG_SIZE = { width: COVER_WIDTH, height: COVER_HEIGHT } as const

interface CoverOgImageProps {
  title: string
  /** Optional caption under the title — provenance, a description, a byline. */
  subtitle?: string
}

interface CoverLayout {
  fontSize: number
  lines: string[]
  subtitleLines: string[]
}

/**
 * Largest type size at which the title fits `COVER_MAX_TITLE_LINES`, with the
 * overflow truncated at the smallest step, and the caption wrapped to at most
 * `COVER_MAX_CAPTION_LINES`.
 *
 * Separate from the render so the bound is assertable: every string this
 * returns has to sit inside the fixed canvas, and on the shared-file card both
 * inputs — a file name and a workspace/owner pair — are supplied by whoever
 * created the share.
 */
export function layoutCover({ title, subtitle }: CoverOgImageProps): CoverLayout {
  const smallest = TITLE_FONT_SIZES[TITLE_FONT_SIZES.length - 1]
  let fontSize = smallest
  let lines: string[] = []

  for (const step of TITLE_FONT_SIZES) {
    fontSize = step
    lines = wrapLines(title, step)
    if (lines.length <= COVER_MAX_TITLE_LINES) break
  }

  if (lines.length > COVER_MAX_TITLE_LINES) {
    lines = lines.slice(0, COVER_MAX_TITLE_LINES)
    lines[lines.length - 1] = withEllipsis(lines[lines.length - 1], smallest)
  }

  return { fontSize, lines, subtitleLines: subtitle ? layoutCaption(subtitle) : [] }
}

/**
 * Wraps a caption to at most `COVER_MAX_CAPTION_LINES`, ellipsizing the last
 * line if it still overruns. The lines have to be pre-split here for the same
 * reason the title's are: packing them with U+00A0 leaves Satori no break
 * opportunity, so an unsplit caption would run straight off the right edge
 * rather than wrapping.
 */
function layoutCaption(subtitle: string): string[] {
  const lines = wrapLines(subtitle, SUBTITLE_FONT_SIZE)
  if (lines.length <= COVER_MAX_CAPTION_LINES) return lines

  const kept = lines.slice(0, COVER_MAX_CAPTION_LINES)
  kept[kept.length - 1] = withEllipsis(kept[kept.length - 1], SUBTITLE_FONT_SIZE)
  return kept
}

/** Renders the brandbook cover template for a single title. */
export function createCoverOgImage(props: CoverOgImageProps): Response {
  const { fontSize, lines, subtitleLines } = layoutCover(props)
  const canvas = createCanvas(COVER_WIDTH, COVER_HEIGHT)
  const context = canvas.getContext('2d')
  context.fillStyle = BACKGROUND_COLOR
  context.fillRect(0, 0, COVER_WIDTH, COVER_HEIGHT)
  context.fillStyle = INK_COLOR
  context.font = '600 44px sans-serif'
  context.fillText('Memlia', 30, 66)

  const captionHeight = subtitleLines.length * SUBTITLE_FONT_SIZE * 1.2
  let baseline = COVER_HEIGHT - 36 - captionHeight - (subtitleLines.length ? CAPTION_GAP : 0)
  baseline -= (lines.length - 1) * fontSize * 1.08
  context.font = `500 ${fontSize}px sans-serif`
  for (const line of lines) {
    context.fillText(line, 30, baseline, COVER_TITLE_BOX_WIDTH)
    baseline += fontSize * 1.08
  }
  context.fillStyle = MUTED_INK_COLOR
  context.font = `500 ${SUBTITLE_FONT_SIZE}px sans-serif`
  baseline = COVER_HEIGHT - 30 - (subtitleLines.length - 1) * SUBTITLE_FONT_SIZE * 1.2
  for (const line of subtitleLines) {
    context.fillText(line, 30, baseline, COVER_TITLE_BOX_WIDTH)
    baseline += SUBTITLE_FONT_SIZE * 1.2
  }
  return new Response(new Uint8Array(canvas.toBuffer('image/png')), {
    headers: { 'Content-Type': 'image/png' },
  })
}
