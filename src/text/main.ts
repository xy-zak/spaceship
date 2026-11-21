import { layoutNextLine, prepareWithSegments, type PreparedTextWithSegments } from "@chenglou/pretext"
import { createAuthorMarks, type AuthorBlock } from "../author-marks.ts"
import { $ } from "../dom.ts"
import { abortAll } from "../llm/ollama.ts"
import { commitTurn, createLivePoster, stationOf, swapTo, turnEvents, visibleWindow } from "../net/turns.ts"
import { centeredAt, type Point } from "../point.ts"
import { LENSES, OPENING, type Station } from "../stations.ts"
import { appendTail, lastAuthors, splitTail, tidySpace, wordsOf, type AuthorRun, type Turn } from "../turn-rules.ts"
import { createAttentionKnobs } from "./attention-knobs.ts"
import { caretAt, isAhead, pointAt, type Caret, type TextMetrics } from "./caret.ts"
import { simulatedSource } from "./completion.ts"
import { makeDraggable } from "./drag.ts"
import { createFutureKnobs } from "./future-knobs.ts"
import { layoutLines } from "./layout.ts"
import { circleOf } from "./links.ts"
import { liveAttention } from "./live-attention.ts"
import { controlLine, liveSource } from "./live-completion.ts"
import { liveDimension } from "./live-dimension.ts"
import { liveRealization } from "./live-realization.ts"
import { createPointer, type Aim, type PointerTarget, type SelectionPreview, type Zone } from "./pointer.ts"
import { wordSpans, type Span } from "./segments.ts"
import { simulatedAttention } from "./simulated-attention.ts"
import { simulatedDimension } from "./simulated-dimension.ts"
import { simulatedRealization } from "./simulated-realization.ts"
import { isSoundOn, setSoundOn, startSound } from "./sound/engine.ts"
import { sounds } from "./sound/sounds.ts"
import { showStatus } from "./status-line.ts"
import { storyLayoutOf, type StoryLayout } from "./story-layout.ts"
import { domPointAt, textOffsetOf } from "./text-offsets.ts"
import { createTextStream, type Seed, type Steering } from "./text-stream.ts"
import { countWords, firstWords } from "./words.ts"

const DWELL_MS = 100
/**
 * Generated words kept ready past the knob: whenever fewer remain, the stream continues the text, appending, never rewriting.
 * It is also the most one continuation writes; with a word limit, a continuation writes no further than the turn may reach.
 */
const FUTURE_WORDS = 200
/** A top-up that adds no words (the source failed or said nothing) is retried after this long, doubling each time up to `MAX_RETRY_MS`. */
const RETRY_MS = 1000
const MAX_RETRY_MS = 16000
/** Drag speed, in px per ms, at which the word tick is softest. */
const DRAG_SPEED_FULL = 1.2
/** Tray controls sit flush with each other and the screen's bottom edge, so their brackets are drawn just inside them. */
const TRAY_PAD_PX = -1

const element = $("#text")
const handle = $<HTMLButtonElement>("#pointer")
const statusElement = $("#status")
const soundToggle = $<HTMLButtonElement>("#sound-toggle")
const extraLink = $<HTMLAnchorElement>("#extra-link")
const turnElement = $<HTMLOutputElement>("#turn")
const style = getComputedStyle(element)
await document.fonts.load(style.font)
/** Measures where the first hidden word on the caret's line starts, in the text's font. */
const measure = document.createElement("canvas").getContext("2d")!
measure.font = style.font

const isLive = new URLSearchParams(location.search).get("live") === "true"
/** Without a station the editor runs alone from the opening, for development. */
const station = stationOf(location.search)
const stream = createTextStream(isLive ? liveSource : simulatedSource, render)
const attention = createAttentionKnobs({
  source: isLive ? liveAttention : simulatedAttention,
  textElement: element,
  knob: handle,
  linkPath: $<SVGPathElement>("#attention-links"),
  activeLinkPath: $<SVGPathElement>("#attention-active-link"),
  isPastEnd: (point) => isAhead(caretAt(point, metricsOf()), caret),
  onChange: invalidateFuture,
})
const futureKnobs = createFutureKnobs({
  template: $<HTMLTemplateElement>("#future-knob"),
  mainKnob: handle,
  linkPath: $<SVGPathElement>("#future-links"),
  tunedLinkPath: $<SVGPathElement>("#future-tuned-link"),
  hud: $<SVGGElement>("#future-hud"),
  source: isLive ? liveDimension : simulatedDimension,
  realization: isLive ? liveRealization : simulatedRealization,
  textElement: element,
  context: () => ({ text: shownText, leads: attention.leads() }),
  onChange: invalidateFuture,
})
const drawAuthorMarks = createAuthorMarks($<SVGGElement>("#author-brackets"), $("#bookmarks"))
let caret: Caret = { line: 0, x: 0 }
let shownText = ""
let story: StoryLayout = { content: "", text: "", combined: "", sentences: [] }
let shownCount: number | undefined
/** Words shown where the knob last rested, or where a drag back last discarded the text past it. */
let restCount = 0
let restTimer: number | undefined
/** A drag back discarded the text past the knob; it is generated again only once the knob rests, not at every word on the way. */
let isRegenerationHeld = false
let dwellTimer: number | undefined
/** Counts dwells, so requests deferred by an older one are dropped. */
let dwellCount = 0
let topUpTimer: number | undefined
let retryAt = 0
let retryMs = RETRY_MS
let isFutureStale = false
let prepared: { text: string; layout: PreparedTextWithSegments } | undefined
/** The previous drag point, for how fast the knob moves. */
let lastDrag: { point: Point; at: number } | undefined
/** The turns the editor was seeded from (none before the first state), to mark each station's words and to tell a new state from the same one sent again after a reconnect. */
let seededTurns: Turn[] = []
/** How many new words this turn may add, from the server; null for no limit. */
let wordLimit: number | null = null
let postLive: (tail: string, steering: string[]) => void = () => {}
let isCommitting = false

startSound()
showSoundToggle()
soundToggle.addEventListener("click", () => {
  setSoundOn(!isSoundOn())
  showSoundToggle()
})

// A press with Shift held opens the fan menu: the new future knob takes the press, so the main knob neither scrubs nor sounds its grab.
handle.addEventListener("pointerdown", (event) => {
  if (!event.shiftKey) return
  event.stopImmediatePropagation()
  // keeps Shift and press from extending a text selection
  event.preventDefault()
  futureKnobs.spawn({ x: event.pageX, y: event.pageY }, event.pointerId)
})
// A double click expands or collapses; Shift presses open fan menus instead.
handle.addEventListener("dblclick", ({ shiftKey }) => shiftKey || detachAllOrExpand())
handle.addEventListener("pointerenter", ({ buttons, pageX }) => buttons || sounds.knobHover(pageX))
handle.addEventListener("pointerdown", ({ pageX }) => sounds.knobGrab(pageX))
// Dragging scrubs at once, forward or back.
makeDraggable(handle, {
  onDrag: (point) => {
    handle.toggleAttribute("data-dragging", true)
    const before = shownCount
    moveTo(point)
    discardIfBehindRest()
    soundWordsCrossed(before, point)
  },
  onDrop: () => {
    if (handle.hasAttribute("data-dragging")) sounds.knobRelease(circleOf(handle).center.x)
    handle.removeAttribute("data-dragging")
    lastDrag = undefined
  },
})

createPointer({
  layer: $("#cursor"),
  targets: pointerTargets,
  isDragging: () => handle.hasAttribute("data-dragging") || document.querySelector(".future[data-dragging]") !== null || attention.isDragging(),
  zoneAt,
  caretAt: caretBoxAt,
  selection: selectionPreview,
  aim: aimAt,
  pull: pullToward,
})

// Enter stands in for the panel's OK
addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.repeat && station && !(event.target as Element).closest("dialog, #tray")) passTurn(station)
})
if (station) followTurns(station)
else start({ head: "", text: OPENING, floorWords: countWords(OPENING) })

/** The first state seeds the editor. Later, the page swaps once the turn moves on, and reloads if the turns changed under it, as after a reset. */
async function followTurns(station: Station) {
  const label = `${station} · ${LENSES[station]}`
  turnElement.hidden = false
  turnElement.dataset.station = station
  for await (const event of turnEvents()) {
    if (event.type === "offline") turnElement.value = `${label} · reconnecting…`
    if (event.type !== "state") continue
    const { active, turns } = event.state
    if (active !== station) return swapTo("view")
    wordLimit = event.state.wordLimit
    if (!seededTurns.length) {
      seededTurns = turns
      start(visibleWindow(turns))
      postLive = createLivePoster(station)
      report()
    } else if (JSON.stringify(turns) !== JSON.stringify(seededTurns)) location.reload()
    if (!isCommitting) turnElement.value = label
  }
}

/** The knob starts after the last seeded word, so the turn opens with the whole previous turn shown. */
function start(seed: Seed) {
  stream.seed(seed)
  addEventListener("resize", () => moveTo(pointAt(caret, metricsOf())))
  moveTo(pointAt(caretAfterWords(countWords(seed.text)) ?? caret, metricsOf()))
}

async function passTurn(station: Station) {
  if (isCommitting || !seededTurns.length) return
  isCommitting = true
  turnElement.value = "passing…"
  abortAll()
  const result = await commitTurn(station, tail())
  if (result !== "failed") return swapTo("view")
  isCommitting = false
  turnElement.value = "not sent, press Enter again"
}

/** The knob stops at the column's right edge, as no line reaches past it, never shows fewer words than the floor, and stops at the word limit. */
function moveTo({ x, y }: Point) {
  const { left, width } = element.getBoundingClientRect()
  let point = { x: Math.min(x, left + scrollX + width), y }
  caret = caretAt(point, metricsOf())
  const floor = caretAfterWords(stream.floorWords)
  const ceiling = ceilingWords()
  const limit = ceiling === undefined ? undefined : caretAfterWords(ceiling)
  const clamped = floor && isAhead(floor, caret) ? floor : limit && isAhead(caret, limit) ? limit : undefined
  if (clamped) {
    caret = clamped
    point = pointAt(clamped, metricsOf())
  }
  handle.style.translate = centeredAt(point, handle.offsetWidth)
  render()
  restartRest()
}

/** The knob rests once it has not moved for `DWELL_MS`; the text past it is then generated again if a drag back discarded it. */
function restartRest() {
  clearTimeout(restTimer)
  restTimer = setTimeout(() => {
    restCount = shownCount ?? 0
    isRegenerationHeld = false
    topUp()
  }, DWELL_MS)
}

/** Dragging back far enough to hide the word the knob rested on means the reader wants another continuation, so the text past the knob is discarded at once. */
function discardIfBehindRest() {
  const count = shownCount ?? 0
  if (count >= restCount) return
  stream.truncate(count)
  restCount = count
  isRegenerationHeld = true
}

function detachAllOrExpand() {
  if (!attention.isExpanded() && !futureKnobs.count()) return revealAttention()
  sounds.collapse(circleOf(handle).center.x)
  attention.collapse()
  futureKnobs.clear()
}

/** The continuation generated alongside the prefetched boxes was not led by them, so it is replaced as soon as they are all shown. */
async function revealAttention() {
  await attention.expand()
  regenerateFuture()
  afterStreaming(futureKnobs.preload)
}

function render() {
  /** Unrounded, unlike `clientWidth`: a line that fills the column exactly measures a hair wider than the rounded width. */
  const lines = layoutLines(prepareWords(), caret, element.getBoundingClientRect().width)
  const text = lines.join(" ")
  const count = countWords(text)

  if (count !== shownCount) restartDwell()
  shownCount = count
  scheduleTopUp()
  story = storyLayoutOf(lines, stream.text)
  if (element.textContent !== story.content) element.textContent = story.content
  shownText = text
  if (station && seededTurns.length)
    drawAuthorMarks(authorBlocks(text, lastAuthors(appendTail(seededTurns, station, tail(), wordLimit), count)), element.getBoundingClientRect().left + scrollX)
  attention.update(text)
  futureKnobs.follow(story)
  report()
}

/** The text after the knob was steered by the previous boxes and future knobs, so it is regenerated once they settle. */
function invalidateFuture() {
  isFutureStale = true
  restartDwell()
  report()
}

/** Shows whether the model is generating and how full the buffer past the knob is, on the knob and in the status line, with what the text holds and is steered by. */
function report() {
  const activity = stream.activity()
  const buffer = Math.max(0, countWords(stream.text) - (shownCount ?? 0))
  handle.toggleAttribute("data-generating", activity.isGenerating)
  // full once the text holds all a generation would add here: `FUTURE_WORDS`, or the rest of the word limit
  const ready = Math.min(FUTURE_WORDS, (ceilingWords() ?? Infinity) - (shownCount ?? 0))
  handle.style.setProperty("--buffer", `${ready > 0 ? Math.min(1, buffer / ready) : 1}`)
  showStatus(statusElement, {
    ...activity,
    words: shownCount ?? 0,
    buffer,
    boxes: attention.leads().length,
    steering: futureKnobs.controls().length,
    pinned: futureKnobs.pinnedCount(),
    turn: station && seededTurns.length ? { words: wordsOf(splitTail(seededTurns, tail()).fresh).length, limit: wordLimit } : undefined,
  })
  // clipped to the server's limits, which would refuse the whole post
  postLive(
    tail(),
    futureKnobs
      .controls()
      .slice(0, 16)
      .map((control) => controlLine(control).slice(0, 200)),
  )
}

/** The most words the knob may show: the floor, the words of the last turn this one keeps, and the word limit; undefined for no limit. */
function ceilingWords() {
  if (wordLimit === null || !seededTurns.length) return
  const text = tidySpace(stream.text)
  const { kept } = splitTail(seededTurns, text.slice(firstWords(text, stream.floorWords).length))
  return stream.floorWords + countWords(kept) + wordLimit
}

/** The shown words after the floor, single-spaced with blank lines between paragraphs: the text this turn hands the server. */
function tail() {
  const text = tidySpace(stream.text)
  return tidySpace(text.slice(firstWords(text, stream.floorWords).length, firstWords(text, shownCount ?? 0).length))
}

function restartDwell() {
  clearTimeout(dwellTimer)
  const dwell = ++dwellCount
  dwellTimer = setTimeout(() => {
    if (isFutureStale) regenerateFuture()
    else topUp()
    afterStreaming(() => {
      if (dwell !== dwellCount) return
      attention.prefetch()
      futureKnobs.preload()
    })
  }, DWELL_MS)
}

/**
 * Runs `request` once the continuation is streaming. Keyword highlights and future knob menus share the text API's rate limit,
 * and the continuation is what the reader waits for, so it is always asked first.
 */
function afterStreaming(request: () => void) {
  stream.streaming().then(request)
}

function regenerateFuture() {
  isFutureStale = false
  restCount = shownCount ?? 0
  stream.truncate(restCount)
  const words = wordsToWrite()
  if (words > 0) stream.generate("steering changed", steering(), words)
}

/** How many words a continuation from the end of the text writes: `FUTURE_WORDS`, or fewer once the word limit is that close. */
function wordsToWrite() {
  return Math.min(FUTURE_WORDS, (ceilingWords() ?? Infinity) - countWords(stream.text))
}

function steering(): Steering {
  return { leads: attention.leads(), controls: futureKnobs.controls() }
}

/**
 * Keeps at least `FUTURE_WORDS` generated words past the knob, or as many as the word limit allows, continuing the text from its end whenever fewer remain.
 * Asked after every change, but run on the next task, after a finished generation has reported how it went.
 */
function scheduleTopUp() {
  topUpTimer ??= setTimeout(() => {
    topUpTimer = undefined
    topUp()
  })
}

function topUp() {
  if (isRegenerationHeld || stream.activity().isGenerating || performance.now() < retryAt) return
  const words = countWords(stream.text)
  const wanted = wordsToWrite()
  if (words - (shownCount ?? 0) >= FUTURE_WORDS || wanted <= 0) return
  stream.generate("buffer low", steering(), wanted).then(
    (outcome) => outcome === "done" && settleTopUp(words),
    (error) => (console.error(error), settleTopUp(words)),
  )
}

/** A top-up that added words resets the retry delay; one that added none waits before trying again, longer each time. */
function settleTopUp(wordsBefore: number) {
  if (countWords(stream.text) > wordsBefore) {
    retryMs = RETRY_MS
    retryAt = 0
    return scheduleTopUp()
  }
  retryAt = performance.now() + retryMs
  setTimeout(scheduleTopUp, retryMs)
  retryMs = Math.min(retryMs * 2, MAX_RETRY_MS)
}

function prepareWords() {
  const text = stream.text
  // pre-wrap, so the model's blank lines break the text into paragraphs; tidied, so no other whitespace shows
  if (prepared?.text !== text) prepared = { text, layout: prepareWithSegments(tidySpace(text), style.font, { whiteSpace: "pre-wrap" }) }
  return prepared.layout
}

/** What the pointer frames as the hand nears it: the main knob (labelled with its word count), each future knob, each attention box line by line, and the tray's toggle and extra link. */
function pointerTargets(): PointerTarget[] {
  return [
    { rects: [handle.getBoundingClientRect()], pad: 5, wake: handle, label: () => `<b>${shownCount ?? 0}</b> words` },
    ...[...document.querySelectorAll<HTMLElement>(".future")].map((knob) => ({ rects: [knob.getBoundingClientRect()], pad: 5 })),
    ...attention.spans().map(({ phrase }) => ({ rects: clientRectsOf(phrase), pad: 3, label: () => "box" })),
    { rects: [soundToggle.getBoundingClientRect()], pad: TRAY_PAD_PX, isHotOnHover: true, wake: soundToggle },
    { rects: [extraLink.getBoundingClientRect()], pad: TRAY_PAD_PX, isHotOnHover: true, wake: extraLink },
  ]
}

/** Each station's run of the shown text; the opening is left unmarked, and the run ending at the knob stays open, as the knob marks its end. */
function authorBlocks(text: string, authors: AuthorRun[]): AuthorBlock[] {
  const words = [...text.matchAll(/\S+/g)]
  let next = words.length - authors.reduce((sum, { words }) => sum + words, 0)
  return authors.flatMap(({ station, words: count }) => {
    const [first, last] = [words[next], words[next + count - 1]]
    next += count
    if (station === "opening" || !count) return []
    return [{ station, range: rangeOf({ start: first.index, end: last.index + last[0].length }), isOpen: next === words.length }]
  })
}

/** The viewport boxes of a span of the shown text, one per line it covers. */
function clientRectsOf(span: Span) {
  return [...rangeOf(span).getClientRects()].filter(({ width }) => width > 0)
}

function rangeOf({ start, end }: Span) {
  const range = document.createRange()
  range.setStart(...domPointAt(element, start))
  range.setEnd(...domPointAt(element, end))
  return range
}

/**
 * What lies under the viewport point: knobs, controls, the tray and dialogs have gestures of their own; past the main knob there is no text yet,
 * so the page there is where a press steers; before it, the shown text selects, except an attention box, which drags.
 */
function zoneAt(target: Element, x: number, y: number): Zone {
  const point = { x: x + scrollX, y: y + scrollY }
  if (attention.isDragging()) return "box"
  if (target.closest(".knob, button, a, #tray, dialog")) return "other"
  if (isAhead(caretAt(point, metricsOf()), caret)) return "ahead"
  if (!target.closest("#text")) return "other"
  return attention.isOverBox(point) ? "box" : "text"
}

/** The caret between characters nearest the viewport point, line-high, while over the shown text. */
function caretBoxAt(x: number, y: number) {
  const position = document.caretPositionFromPoint(x, y)
  if (!position || !element.contains(position.offsetNode)) return
  return caretBoxOf(position.offsetNode, position.offset)
}

/** A line-high box at zero width where the caret before character `offset` of `node` sits. */
function caretBoxOf(node: Node, offset: number) {
  const range = document.createRange()
  range.setStart(node, offset)
  const rect = range.getClientRects()[0] ?? range.getBoundingClientRect()
  const { top } = element.getBoundingClientRect()
  const lineHeight = parseFloat(style.lineHeight)
  const textTop = top + parseFloat(style.paddingTop)
  const line = Math.floor((rect.top + rect.height / 2 - textTop) / lineHeight)
  return new DOMRect(rect.left, textTop + line * lineHeight, 0, lineHeight)
}

/** While a selection is made in the text: carets at its ends, and the whole words it will become as a box (as the attention box from a selection rounds it). */
function selectionPreview(): SelectionPreview | undefined {
  const selection = getSelection()
  if (!selection?.rangeCount || selection.isCollapsed || !selection.anchorNode || !selection.focusNode || !element.contains(selection.anchorNode)) return
  const range = selection.getRangeAt(0)
  const start = textOffsetOf(element, range.startContainer, range.startOffset)
  const end = textOffsetOf(element, range.endContainer, range.endOffset)
  const words = wordSpans(shownText)
  const first = words.findIndex((word) => word.end > start)
  const last = words.findLastIndex((word) => word.start < end)
  return {
    anchor: caretBoxOf(selection.anchorNode, selection.anchorOffset),
    focus: caretBoxOf(selection.focusNode, selection.focusOffset),
    words: first === -1 || last < first ? [] : clientRectsOf({ start: words[first].start, end: words[last].end }),
  }
}

/** Where the main knob would stop for the viewport point `x`, `y`: how many words ahead (or behind) that is, and the box of the last word it shows now. */
function aimAt(x: number, y: number): Aim {
  const width = element.getBoundingClientRect().width
  const target = caretAt({ x: x + scrollX, y: y + scrollY }, metricsOf())
  const lines = layoutLines(prepareWords(), { line: target.line, x: Math.min(target.x, width) }, width)
  const knob = handle.getBoundingClientRect()
  return {
    gap: countWords(lines.join(" ")) - (shownCount ?? 0),
    tip: tipRect(),
    knob: { x: knob.x + knob.width / 2, y: knob.y + knob.height / 2 },
  }
}

/** The viewport box of the last word the main knob shows. */
function tipRect() {
  const caret = caretAfterWords(shownCount ?? 0)
  return caret && lastWordRect(layoutLines(prepareWords(), caret, element.getBoundingClientRect().width))
}

/** The viewport box of the last word of `lines`, laid out in the column. */
function lastWordRect(lines: string[]) {
  const index = lines.findLastIndex((line) => line.trim())
  if (index === -1) return
  const line = lines[index].trimEnd()
  const word = line.slice(line.lastIndexOf(" ") + 1)
  const { left, top } = element.getBoundingClientRect()
  const lineHeight = parseFloat(style.lineHeight)
  const x = left + measure.measureText(line.slice(0, line.length - word.length)).width
  return new DOMRect(x, top + parseFloat(style.paddingTop) + index * lineHeight, measure.measureText(word).width, lineHeight)
}

/** Steering: moves the main knob `words` further along the reading order, as if dragged there, ticking once per word. */
function pullToward(_x: number, _y: number, words: number) {
  const next = caretAfterWords((shownCount ?? 0) + words)
  if (!next) return
  const before = shownCount
  const point = pointAt(next, metricsOf())
  moveTo(point)
  soundWordsCrossed(before, point)
}

/** The caret that shows exactly `count` words, or undefined while the text holds fewer. */
function caretAfterWords(count: number): Caret | undefined {
  const width = element.getBoundingClientRect().width
  const layout = prepareWords()
  let cursor
  let seen = 0
  for (let line = 0; ; line++) {
    const next = layoutNextLine(layout, width, cursor)
    if (!next) return
    const words = countWords(next.text)
    if (seen + words >= count) return { line, x: Math.min(width, measure.measureText(firstWords(next.text, count - seen)).width + 1) }
    seen += words
    cursor = next.end
  }
}

/** Ticks once per word the dragged knob reveals or removes; words arriving from the generator are silent. */
function soundWordsCrossed(before: number | undefined, point: Point) {
  const now = performance.now()
  const speed = lastDrag ? Math.hypot(point.x - lastDrag.point.x, point.y - lastDrag.point.y) / Math.max(1, now - lastDrag.at) / DRAG_SPEED_FULL : 0
  lastDrag = { point, at: now }
  if (before !== undefined && shownCount !== undefined && shownCount !== before)
    sounds.word(Math.sign(shownCount - before), Math.abs(shownCount - before), speed, point.x)
}

function showSoundToggle() {
  const isOn = isSoundOn()
  soundToggle.setAttribute("aria-pressed", `${isOn}`)
  soundToggle.querySelector("b")!.textContent = isOn ? "on" : "off"
}

/** Read on every use, since the centered column moves with the window. */
function metricsOf(): TextMetrics {
  const { left, top } = element.getBoundingClientRect()
  return { left: left + scrollX, top: top + scrollY + parseFloat(style.paddingTop), lineHeight: parseFloat(style.lineHeight) }
}
