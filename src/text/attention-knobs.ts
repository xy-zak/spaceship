import type { Point } from "../point.ts"
import { startAttention, type AttentionBox, type AttentionGeneration, type AttentionSource, type Lead } from "./attention.ts"
import { makeDraggable } from "./drag.ts"
import { circleOf, distance, linkBetween, pathOf } from "./links.ts"
import { wordSpans, type Span } from "./segments.ts"
import { sounds } from "./sound/sounds.ts"
import { domPointAt, textOffsetOf } from "./text-offsets.ts"

const KEYWORD_HIGHLIGHT = "attention-word"
/** The keyword of the box under the pointer or being dragged, set apart since it is what a drag moves. */
const ACTIVE_KEYWORD_HIGHLIGHT = "attention-word-active"
/** Must match the `::highlight(attention-shade-N)` rules in the page styles. */
const SHADE_LEVELS = 5

type AttentionKnobsOptions = {
  source: AttentionSource
  textElement: HTMLElement
  knob: HTMLElement
  /** Draws a line from each keyword's underline to `knob`. */
  linkPath: SVGPathElement
  /** Draws the link of the box under the pointer or being dragged, instead of `linkPath`. */
  activeLinkPath: SVGPathElement
  isPastEnd: (point: Point) => boolean
  /** Called when the user changes the boxes or the text drops some; may fire in quick succession while dragging. Not called by `expand`, which the caller can await. */
  onChange: () => void
}

/**
 * Attention knobs are shaded boxes of words: generated around keywords by expanding, or made from a text selection.
 * Dragging a box moves its keyword to the word under the pointer; double clicking a word boxes it, and double clicking a box deletes it.
 * `text` must equal the element's text with line breaks as spaces, so offsets match the DOM text, which may be split across child elements.
 */
export function createAttentionKnobs({ source, textElement, knob, linkPath, activeLinkPath, isPastEnd, onChange }: AttentionKnobsOptions) {
  const lineHeight = parseFloat(getComputedStyle(textElement).lineHeight)
  /** Later boxes are on top, so they are grabbed first. */
  let boxes: AttentionBox[] = []
  let grabbed: AttentionBox | undefined
  /** The box under the pointer or being dragged. */
  let active: AttentionBox | undefined
  let text = ""
  let words: Span[] = []
  let wordRects: DOMRect[] | undefined
  let prefetched: AttentionGeneration | undefined
  let shown: AttentionGeneration | undefined
  /** The pointer's latest page x over the text, where box sounds come from. */
  let pointerX = 0
  /** The box the latest selection made, which the double click that selected its word keeps. */
  let selected: AttentionBox | undefined

  makeDraggable(textElement, { onStart: grab, onDrag: moveGrabbed, onDrop: dropGrabbed })
  textElement.addEventListener("mousedown", (event) => {
    selected = undefined
    if (boxAt(pointOf(event)) !== -1) event.preventDefault()
  })
  textElement.addEventListener("pointermove", (event) => {
    pointerX = event.pageX
    const index = boxAt(pointOf(event))
    textElement.style.cursor = index === -1 ? "" : "grab"
    hover(grabbed ?? boxes[index])
  })
  textElement.addEventListener("pointerleave", () => hover(grabbed))
  textElement.addEventListener("dblclick", (event) => {
    const index = boxAt(pointOf(event))
    if (index !== -1 && boxes[index] === selected) return
    if (deleteBox(index)) sounds.remove(event.pageX)
  })
  document.addEventListener("pointerup", boxSelection)

  return {
    update,
    prefetch,
    expand,
    collapse,
    leads,
    spans,
    isExpanded: () => boxes.length > 0 || shown !== undefined,
    isDragging: () => grabbed !== undefined,
    /** Whether the page point is on a box, which a press there would drag. */
    isOverBox: (point: Point) => boxAt(point) !== -1,
  }

  /** Repaints even when `nextText` is unchanged, because the main knob may have moved. */
  function update(nextText: string) {
    if (nextText !== text) {
      text = nextText
      words = wordSpans(text)
      wordRects = undefined
      const kept = boxes.filter(({ keyword }) => keyword < words.length)
      const isDropped = kept.length < boxes.length
      boxes = kept
      discardPrefetched()
      if (isDropped) onChange()
    }
    paint()
  }

  function leads(): Lead[] {
    return boxes.map((box) => {
      const [first, last] = spanOf(box, words.length)
      const keyword = words[box.keyword]
      return {
        before: text.slice(words[first].start, keyword.start),
        keyword: text.slice(keyword.start, keyword.end),
        after: text.slice(keyword.end, words[last].end),
      }
    })
  }

  /** Each box's phrase and keyword as spans of the text, and whether it is under the pointer or dragged; in the order of `leads`. */
  function spans(): BoxSpans[] {
    return boxes.map((box) => {
      const [first, last] = spanOf(box, words.length)
      return { phrase: { start: words[first].start, end: words[last].end }, keyword: words[box.keyword], isActive: box === active }
    })
  }

  function prefetch() {
    if (words.length && prefetched?.text !== text) prefetched = startAttention(source, text)
  }

  /** Generates boxes, adding each as it arrives. */
  async function expand() {
    if (!words.length) return
    const generation = takePrefetched() ?? startAttention(source, text)
    shown = generation
    let revealed = 0
    for await (const box of generation) {
      if (shown !== generation) return
      if (box.keyword >= words.length) continue
      addBox({ ...box })
      sounds.boxRevealed(revealed++, pageRect(rangeOf(box.keyword, box.keyword).getBoundingClientRect()).x)
    }
    if (shown === generation) shown = undefined
  }

  /** Removes all boxes, including those still arriving. */
  function collapse() {
    shown?.abort()
    shown = undefined
    const hadBoxes = boxes.length > 0
    boxes = []
    paint()
    if (hadBoxes) onChange()
  }

  function takePrefetched() {
    const generation = prefetched
    prefetched = undefined
    if (generation?.text === text) return generation
    generation?.abort()
  }

  function discardPrefetched() {
    prefetched?.abort()
    prefetched = undefined
  }

  function boxSelection({ pageX }: PointerEvent) {
    const selection = getSelection()
    if (!selection?.rangeCount || selection.isCollapsed) return

    const range = selection.getRangeAt(0)
    const start = textOffsetOf(textElement, range.startContainer, range.startOffset)
    const end = textOffsetOf(textElement, range.endContainer, range.endOffset)
    const first = words.findIndex((word) => word.end > start)
    const last = words.findLastIndex((word) => word.start < end)
    if (first === -1 || last < first) return

    const keyword = Math.floor((first + last) / 2)
    selection.removeAllRanges()
    selected = { keyword, before: keyword - first, after: last - keyword }
    addBox(selected)
    sounds.boxCreate(pageX)
    onChange()
  }

  /** Adds `box` on top, replacing boxes on the same keyword. */
  function addBox(box: AttentionBox) {
    boxes = [...boxes.filter((other) => other !== box && other.keyword !== box.keyword), box]
    paint()
  }

  /** Returns whether there was a box to delete. */
  function deleteBox(index: number) {
    if (index === -1) return false
    boxes.splice(index, 1)
    paint()
    onChange()
    return true
  }

  function grab(point: Point) {
    const index = boxAt(point)
    if (index === -1) return false
    grabbed = boxes.splice(index, 1)[0]
    boxes.push(grabbed)
    sounds.boxGrab(point.x)
    return true
  }

  function moveGrabbed(point: Point) {
    const word = wordNear(point)
    if (!grabbed || word === undefined || word === grabbed.keyword) return
    grabbed.keyword = word
    sounds.boxHop(point.x)
    paint()
    onChange()
  }

  function dropGrabbed() {
    if (grabbed) {
      addBox(grabbed)
      sounds.boxDrop(pointerX)
    }
    grabbed = undefined
  }

  function hover(box: AttentionBox | undefined) {
    if (box !== active) {
      if (box && !grabbed) sounds.boxHover(pointerX)
      active = box
      paintFocus()
    }
  }

  /** Index of the topmost box containing `point` (-1 if none), treating the full line height as part of the box so lines leave no gaps. */
  function boxAt({ x, y }: Point) {
    if (!words.length) return -1
    return boxes.findLastIndex((box) =>
      [...rangeOf(...spanOf(box, words.length)).getClientRects()].some((rect) => {
        const { left, right, top, height } = pageRect(rect)
        return x >= left && x <= right && Math.abs(y - (top + height / 2)) <= lineHeight / 2
      }),
    )
  }

  function paint() {
    const coverage = coverageOf(boxes, words.length)
    for (let level = 1; level <= SHADE_LEVELS; level++) {
      const ranges = runsAtLeast(coverage, level).map(([first, last]) => rangeOf(first, last))
      CSS.highlights.set(`attention-shade-${level}`, new Highlight(...ranges))
    }
    paintFocus()
  }

  /** Underlines each keyword and links it to the knob, the active box's apart from the others. */
  function paintFocus() {
    const isActive = (box: AttentionBox) => box === active && boxes.includes(box)
    const keywords = (shown: AttentionBox[]) => new Highlight(...shown.map(({ keyword }) => rangeOf(keyword, keyword)))
    const others = boxes.filter((box) => !isActive(box))
    const focused = boxes.filter(isActive)
    CSS.highlights.set(KEYWORD_HIGHLIGHT, keywords(others))
    CSS.highlights.set(ACTIVE_KEYWORD_HIGHLIGHT, keywords(focused))
    linkPath.setAttribute("d", linksOf(others))
    activeLinkPath.setAttribute("d", linksOf(focused))
  }

  /** Links each keyword's underline end closer to the knob. */
  function linksOf(linked: AttentionBox[]) {
    const main = circleOf(knob)
    const nearerEnd = (ends: Point[]) => ends.reduce((nearer, end) => (distance(end, main.center) < distance(nearer, main.center) ? end : nearer))
    return pathOf(linked.map(({ keyword }) => linkBetween({ center: nearerEnd(underlineOf(keyword)), radius: 0 }, main)))
  }

  /** Underline ends of `word`, assuming `text-underline-position: under` puts it at the bottom of the text box. */
  function underlineOf(word: number): [Point, Point] {
    const { left, right, bottom } = pageRect(rangeOf(word, word).getBoundingClientRect())
    const y = bottom - parseFloat(getComputedStyle(linkPath).strokeWidth) / 2
    return [
      { x: left, y },
      { x: right, y },
    ]
  }

  function wordNear(point: Point) {
    if (!words.length || isPastEnd(point)) return
    wordRects ??= words.map((_, index) => pageRect(rangeOf(index, index).getBoundingClientRect()))
    return nearestIndex(wordRects, point)
  }

  function rangeOf(firstWord: number, lastWord: number) {
    const range = document.createRange()
    range.setStart(...domPointAt(textElement, words[firstWord].start))
    range.setEnd(...domPointAt(textElement, words[lastWord].end))
    return range
  }
}

export type BoxSpans = { phrase: Span; keyword: Span; isActive: boolean }

/** `[first, last]` words of `box`, clipped to the text. */
function spanOf({ keyword, before, after }: AttentionBox, wordCount: number): [number, number] {
  return [Math.max(0, keyword - before), Math.min(wordCount - 1, keyword + after)]
}

/** Counts, per word, how many boxes include it. */
function coverageOf(boxes: AttentionBox[], wordCount: number) {
  const coverage = new Array<number>(wordCount).fill(0)
  for (const box of boxes) {
    const [first, last] = spanOf(box, wordCount)
    for (let i = first; i <= last; i++) coverage[i]++
  }
  return coverage
}

/** Contiguous `[first, last]` word runs covered at least `level` times. */
function runsAtLeast(coverage: number[], level: number) {
  const runs: [number, number][] = []
  coverage.forEach((count, i) => {
    if (count < level) return
    const run = runs.at(-1)
    if (run?.[1] === i - 1) run[1] = i
    else runs.push([i, i])
  })
  return runs
}

/** Prefers the nearest line, then the nearest word on that line, so gaps between lines and words still map to a word. */
function nearestIndex(rects: DOMRect[], point: Point) {
  const distance = (rect: DOMRect) => [gap(point.y, rect.top, rect.bottom), gap(point.x, rect.left, rect.right)]
  return rects.reduce((best, rect, i) => {
    const [dy, dx] = distance(rect)
    const [bestDy, bestDx] = distance(rects[best])
    return dy < bestDy || (dy === bestDy && dx < bestDx) ? i : best
  }, 0)
}

function gap(value: number, min: number, max: number) {
  return Math.max(min - value, 0, value - max)
}

function pointOf({ pageX, pageY }: MouseEvent): Point {
  return { x: pageX, y: pageY }
}

function pageRect({ x, y, width, height }: DOMRect) {
  return new DOMRect(x + scrollX, y + scrollY, width, height)
}
