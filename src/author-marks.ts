import type { Point } from "./point.ts"
import { STATIONS, type Station } from "./stations.ts"

/** A station's words, as a range of the page's text; an open block is still being written, so it has no closing bracket yet. */
export type AuthorBlock = { station: Station; range: Range; isOpen?: boolean }

/** Room between the words and their brackets. */
const PAD_PX = 3
/** Arm length of a bracket. */
const ARM_PX = 4
/** Room between the column and the tags, so a tag never seems to bracket the text before a block that starts mid-line. */
const TAG_GAP_PX = 8

type Placed = AuthorBlock & { lines: DOMRect[] }

/**
 * Marks each station's block of text: a bracket in the station's color where it starts and, once closed, where it ends, and a tag of the station's name
 * on the line it starts on, sticking out left of the column like a bookmark. Blocks that start on the same line share one row of tags.
 * The block under the hand, or whose tag the hand is on, is highlighted in its station's color.
 */
export function createAuthorMarks(brackets: SVGGElement, bookmarks: HTMLElement) {
  let placed: Placed[] = []
  /** The page box of each placed block's tag. */
  let tagBoxes: DOMRect[] = []
  let hand: Point | undefined
  let highlighted: Placed | undefined
  let drawn = { paths: "", tags: "" }

  addEventListener("pointermove", ({ pageX, pageY }) => {
    hand = { x: pageX, y: pageY }
    highlight()
  })
  document.documentElement.addEventListener("pointerleave", () => {
    hand = undefined
    highlight()
  })

  /** `left` is the column's page x. Call again whenever the text or its layout changes, as the ranges and boxes go stale. */
  return function draw(blocks: AuthorBlock[], left: number) {
    placed = blocks.flatMap((block) => {
      const lines = [...block.range.getClientRects()]
        .filter(({ width }) => width > 0)
        .map(onPage)
        .sort((a, b) => a.top - b.top)
      return lines.length ? [{ ...block, lines }] : []
    })
    const paths = placed
      .map(({ station, lines, isOpen }) => `<path data-station="${station}" d="${bracketsOf(lines[0], isOpen ? undefined : lines[lines.length - 1])}" />`)
      .join("")
    const tags = [...Map.groupBy(placed, ({ lines }) => lines[0].top).values()]
      .map((row) => {
        const { top, height } = row[0].lines[0]
        const style = `left: ${left - PAD_PX - TAG_GAP_PX}px; top: ${top - PAD_PX}px; height: ${height + 2 * PAD_PX}px`
        return `<div style="${style}">${row.map(({ station }) => `<span data-station="${station}">${station}</span>`).join("")}</div>`
      })
      .join("")
    if (paths !== drawn.paths) brackets.innerHTML = paths
    if (tags !== drawn.tags) bookmarks.innerHTML = tags
    drawn = { paths, tags }
    // the tags are in the same order as the blocks, as each row of them is
    tagBoxes = [...bookmarks.querySelectorAll("span")].map((tag) => onPage(tag.getBoundingClientRect()))
    highlighted = undefined
    highlight()
  }

  function highlight() {
    const hovered = hand && placed.find(({ lines }, i) => [...lines, tagBoxes[i]].some((box) => box && isNear(box, hand!)))
    if (hovered === highlighted) return
    highlighted = hovered
    for (const station of STATIONS) CSS.highlights.set(`author-${station}`, hovered?.station === station ? new Highlight(hovered.range) : new Highlight())
  }
}

/** A `[` before the block's first line, and a `]` after its last one if given. */
function bracketsOf(first: DOMRect, last?: DOMRect) {
  const x0 = first.left - PAD_PX
  const open = `M${x0 + ARM_PX},${first.top - PAD_PX}H${x0}V${first.bottom + PAD_PX}H${x0 + ARM_PX}`
  if (!last) return open
  const x1 = last.right + PAD_PX
  return `${open}M${x1 - ARM_PX},${last.top - PAD_PX}H${x1}V${last.bottom + PAD_PX}H${x1 - ARM_PX}`
}

function onPage({ x, y, width, height }: DOMRect) {
  return new DOMRect(x + scrollX, y + scrollY, width, height)
}

/** On the box or in the room around it, so the highlight holds while the hand crosses between lines. */
function isNear({ left, right, top, bottom }: DOMRect, { x, y }: Point) {
  return x >= left - PAD_PX && x <= right + PAD_PX && y >= top - PAD_PX && y <= bottom + PAD_PX
}
