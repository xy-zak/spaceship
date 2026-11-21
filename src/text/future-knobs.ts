import type { Point } from "../point.ts"
import type { Lead } from "./attention.ts"
import { strengthLevelOf, optionIndexAt, valueOf, type Control, type Dimension, type DimensionSource } from "./dimension.ts"
import { makeDraggable } from "./drag.ts"
import { axisFor, visibleViewport } from "./fan-axis.ts"
import { GRADUATIONS, hudNodesOf, NUMBERED_EVERY, RULER_STEPS, STRENGTH_RANGE_PX, SWING_RADIANS, type ReadoutPart } from "./future-hud.ts"
import { circleOf, linkBetween, pathOf } from "./links.ts"
import { placeInRightMargin } from "./margin-pins.ts"
import type { RealizationSource } from "./realization.ts"
import { createRealizationTracker, type Tracking } from "./realization-tracker.ts"
import type { Span } from "./segments.ts"
import type { Sound } from "./sound/engine.ts"
import { sounds, type DragBed } from "./sound/sounds.ts"
import type { StoryLayout } from "./story-layout.ts"
import { domPointAt } from "./text-offsets.ts"

const PENDING_VALUE = "…"
/** Distances beyond touching the main knob: nearer than the dead zone no dimension is a candidate; at the gate the candidate is chosen. */
const MENU_DEAD_ZONE_PX = 24
const MENU_GATE_PX = 96
/** Once the sentence under the main knob delivers a knob's control this surely, the knob pins to it. */
const REALIZED_CONFIDENCE = 0.8
/** Must match the `::highlight(pinned-sentence)` rule in the page styles. */
const PINNED_HIGHLIGHT = "pinned-sentence"
/** A menu that arrives sooner than this was already on its way, so the knob neither sounds loading nor ready. */
const MENU_LOADING_GRACE_MS = 60
/** Drag speed, in px per ms, at which the drag's click train is loudest. */
const DRAG_SPEED_FULL = 1.2
/** At most this many graduation ticks per move, however far the knob jumps. */
const MAX_TICKS_PER_MOVE = 4
/** Both presses of a double click on a knob fall within this long, as does the release that completes it. */
const DOUBLE_CLICK_MS = 500

type FutureKnobsOptions = {
  template: HTMLTemplateElement
  mainKnob: HTMLElement
  /** Draws each future knob's link, from the main knob's circumference to the knob's. */
  linkPath: SVGPathElement
  /** Draws the link of the knob being tuned, so the other links can dim. */
  tunedLinkPath: SVGPathElement
  /** Holds the rim and labels of the one knob being dragged or hovered. */
  hud: SVGGElement
  source: DimensionSource
  realization: RealizationSource
  /** Pinned knobs sit in the margins beside it, level with their sentence. */
  textElement: HTMLElement
  context: () => { text: string; leads: Lead[] }
  /** Called when what the knobs steer changes: a knob's setting (its value in words and strength level), or a knob pinning. */
  onChange: () => void
}

/** Where a knob was last dragged to relative to the fan: `swing` is its angle from the axis and sets the value, `distance` from the main knob sets the strength. */
type Place = { swing: number; distance: number }

type Menu = { key: string; controller: AbortController; dimensions: Promise<Dimension[] | undefined> }

type FutureKnob = {
  element: HTMLElement
  label: HTMLElement
  /** Where the knob stays on the page, whatever the main knob does afterwards. */
  point: Point
  /** Read off when the knob is dragged, so its value and strength hold when the main knob moves away. */
  place: Place
  /** Offered while choosing; undefined until loaded. */
  menu?: Dimension[]
  /** The menu index the knob has stayed on since it left the dead zone. */
  candidate?: number
  /** How far the knob has travelled toward the gate while choosing, from 0 to 1. */
  progress: number
  /** The chosen dimension; a knob without one is choosing, one with it is tuning. */
  dimension?: Dimension
  setting?: string
  isDragging: boolean
  isHovered: boolean
  controller: AbortController
  /** Set once a tuned knob is dropped, until it is dragged again or pins. */
  tracking?: Tracking
  /** How surely the sentence under the main knob delivers the knob's control, once scored. */
  confidence?: number
  /** The sentence that delivered the control: the knob sits in the margin beside it, labelled, and no longer steers. */
  pinned?: Span
  /** Set once the text grows over the dropped knob: it waits in the right gutter, level with this page y, still steering and linked, until it pins. */
  parkedAt?: number
  sound: KnobSound
}

/** What a knob sounds while it lives. */
type KnobSound = {
  /** Starts the loading sound unless the menu arrives first. */
  loadingTimer?: number
  loading?: Sound
  /** The click train while dragged. */
  bed?: DragBed
  /** Whether the knob moved since it was pressed; a click without moving does not hand off. */
  hasMoved: boolean
  lastDrag?: { point: Point; at: number }
  /** The graduation, option and strength step last sounded while tuning. */
  marks?: { graduation: number; option: number; step: number }
}

/**
 * Future knobs are draggable dials linked to the main knob; each tunes one dimension of the upcoming text.
 * A new knob first offers a menu of dimensions, one sector of the fan each, and carrying the knob through the gate chooses the one in its direction.
 * Then the knob's swing around the main knob picks the value and its distance sets the strength, until it is dropped: it stays there on the page and keeps its setting when the main knob moves.
 * Once dropped, a knob tracks whether the sentence under the main knob delivers its setting, its fill showing how surely, and moves into the margin beside the first sentence that surely does.
 * There it is pinned: unlinked and labelled, it no longer steers and cannot be dragged.
 * A pinned knob is removed when the main knob moves back before its sentence.
 * Double clicking a knob or dropping it onto the main knob deletes it.
 */
export function createFutureKnobs({
  template,
  mainKnob,
  linkPath,
  tunedLinkPath,
  hud,
  source,
  realization,
  textElement,
  context,
  onChange,
}: FutureKnobsOptions) {
  const tracker = createRealizationTracker(realization, () => follow(story))
  let knobs: FutureKnob[] = []
  let preloaded: Menu | undefined
  let axis = 0
  let story: StoryLayout = { content: "", text: "", combined: "", sentences: [] }

  return { preload, spawn, clear, count: () => knobs.length, pinnedCount: () => knobs.filter((knob) => knob.pinned).length, follow, controls }

  /** Takes the text as the main knob or the generator changed it: updates each tracking knob's confidence, pins those realized, and removes pinned ones the main knob moved back past. */
  function follow(next: StoryLayout) {
    story = next
    let hasPinned = false
    const newlyPinned: FutureKnob[] = []
    for (const knob of [...knobs]) {
      if (knob.pinned && story.text.length < knob.pinned.start) remove(knob)
      if (!knob.tracking) continue
      const realized = tracker.realizedUnderKnob(knob.tracking, story)
      if (realized && realized.confidence !== knob.confidence) sounds.realized(realized.confidence, knob.point.x)
      knob.confidence = realized?.confidence
      if (realized && realized.confidence >= REALIZED_CONFIDENCE) {
        pin(knob, realized.sentence)
        newlyPinned.push(knob)
        hasPinned = true
      }
    }
    tracker.score(
      knobs.flatMap((knob) => (knob.tracking ? [knob.tracking] : [])),
      story,
    )
    layout()
    for (const knob of newlyPinned) sounds.pin(knob.point.x)
    if (hasPinned) onChange()
  }

  /** Starts fetching the menu a new knob would get, unless one for the current context is already on its way. */
  function preload() {
    const key = keyOf()
    if (preloaded?.key === key) return
    preloaded?.controller.abort()
    const menu = fetchMenu(key)
    preloaded = menu
    menu.dimensions.then((dimensions) => {
      if (!dimensions && preloaded === menu) preloaded = undefined
    })
  }

  /** Adds a knob at `point` and hands it the pressed pointer, so it follows the pointer until release drops it. */
  function spawn(point: Point, pointerId: number) {
    const key = keyOf()
    if (preloaded?.key !== key) preloaded?.controller.abort()
    const menu = preloaded?.key === key ? preloaded : fetchMenu(key)
    preloaded = undefined

    const element = template.content.firstElementChild!.cloneNode(true) as HTMLElement
    const knob: FutureKnob = {
      element,
      label: element.querySelector("span")!,
      point,
      place: { swing: 0, distance: 0 },
      progress: 0,
      isDragging: true,
      isHovered: false,
      controller: menu.controller,
      sound: { hasMoved: true },
    }
    document.body.append(element)
    knobs.push(knob)
    makeDraggable(element, {
      onStart: () => {
        if (knob.pinned) return false
        unpark(knob)
        knob.isDragging = true
        knob.sound.hasMoved = false
        stopTracking(knob)
        startBed(knob)
        return true
      },
      onDrag: (point) => {
        knob.sound.hasMoved = true
        drag(knob, point)
      },
      onDrop: () => drop(knob),
    })
    onDoubleClick(element, () => remove(knob))
    element.addEventListener("pointerenter", () => ((knob.isHovered = true), layout()))
    element.addEventListener("pointerleave", () => ((knob.isHovered = false), layout()))
    updateAxis()
    drag(knob, point)
    element.setPointerCapture(pointerId)
    sounds.spawn(point.x)
    knob.sound.loadingTimer = setTimeout(() => (knob.sound.loading = sounds.menuLoading(knob.point.x)), MENU_LOADING_GRACE_MS)
    startBed(knob)
    receiveMenu(knob, menu)
  }

  function clear() {
    const hadDimension = knobs.some(isSteering)
    knobs.forEach(dispose)
    knobs = []
    layout()
    if (hadDimension) onChange()
  }

  function layout() {
    const main = circleOf(mainKnob)
    const tuned = knobs.find((knob) => knob.isDragging)
    const shown = tuned ?? knobs.find((knob) => knob.isHovered && !knob.pinned)
    if (!tuned) updateAxis()
    let readout: ReadoutPart[] = []
    for (const knob of knobs) {
      const text = show(knob)
      if (knob === shown) readout = text
      knob.label.hidden = knob === shown
      knob.element.toggleAttribute("data-dimmed", tuned !== undefined && knob !== tuned)
    }
    parkCovered()
    placeInGutter()
    for (const knob of knobs) placeOnPage(knob, main.center)
    const hoveredPins = knobs.flatMap((knob) => (knob.pinned && knob.isHovered ? [rangeOf(knob.pinned)] : []))
    CSS.highlights.set(PINNED_HIGHLIGHT, new Highlight(...hoveredPins))
    const linksOf = (linked: FutureKnob[]) => pathOf(linked.map((knob) => linkBetween(main, { center: knob.point, radius: knob.element.offsetWidth / 2 })))
    linkPath.setAttribute("d", linksOf(knobs.filter((knob) => knob !== tuned && !knob.pinned)))
    linkPath.toggleAttribute("data-dimmed", tuned !== undefined)
    tunedLinkPath.setAttribute("d", linksOf(tuned ? [tuned] : []))
    tunedLinkPath.toggleAttribute("data-choosing", tuned !== undefined && !tuned.dimension)
    hud.replaceChildren(
      ...(shown
        ? hudNodesOf({
            center: main.center,
            rimRadius: shown.dimension ? rimRadiusOf(shown, main.radius) : minDistanceOf(shown, main.radius) + MENU_GATE_PX,
            axis,
            view: viewOf(shown),
            readout,
            knob: { ...shown.place, radius: shown.element.offsetWidth / 2 },
          })
        : []),
    )
  }

  function controls(): Control[] {
    return knobs.flatMap((knob) =>
      knob.dimension && !knob.pinned ? [{ dimension: knob.dimension, position: positionOf(knob), strength: strengthOf(knob) }] : [],
    )
  }

  function keyOf() {
    return JSON.stringify([context(), takenOf().map(({ name }) => name)])
  }

  function takenOf() {
    return knobs.flatMap((knob) => (knob.dimension && !knob.pinned ? [knob.dimension] : []))
  }

  function fetchMenu(key: string): Menu {
    const controller = new AbortController()
    return { key, controller, dimensions: loadMenu(controller.signal) }
  }

  /** Undefined when the source fails or offers nothing; failures are logged here, so nobody has to handle a rejection. */
  async function loadMenu(signal: AbortSignal) {
    try {
      const dimensions = await Array.fromAsync(source({ ...context(), taken: takenOf() }, signal))
      if (signal.aborted) return
      if (!dimensions.length) throw new Error("the dimension source offered nothing")
      return dimensions
    } catch (error) {
      if (!signal.aborted) console.error(error)
    }
  }

  async function receiveMenu(knob: FutureKnob, { dimensions }: Menu) {
    const menu = await dimensions
    if (knob.controller.signal.aborted) return
    const wasLoading = stopLoadingSound(knob)
    if (!menu) {
      sounds.menuFailed(knob.point.x)
      return remove(knob, { silent: true })
    }
    if (wasLoading) sounds.menuReady(knob.point.x)
    knob.menu = menu
    updateCandidate(knob)
    layout()
  }

  function updateAxis() {
    const first = knobs.find((knob) => !knob.pinned)
    if (!first) return
    const main = circleOf(mainKnob)
    axis = axisFor(main.center, rimRadiusOf(first, main.radius), visibleViewport())
  }

  /** Sounds the removal unless `silent`, e.g. when a failure already sounded. */
  function remove(knob: FutureKnob, { silent = false } = {}) {
    if (!knobs.includes(knob)) return
    if (!silent) sounds.remove(knob.point.x)
    dispose(knob)
    knobs = knobs.filter((other) => other !== knob)
    layout()
    if (isSteering(knob)) onChange()
  }

  function dispose(knob: FutureKnob) {
    knob.element.remove()
    knob.controller.abort()
    stopTracking(knob)
    stopLoadingSound(knob)
    knob.sound.bed?.stop()
  }

  /** Returns whether the loading sound had started. */
  function stopLoadingSound({ sound }: FutureKnob) {
    clearTimeout(sound.loadingTimer)
    const { loading } = sound
    loading?.stop()
    sound.loading = sound.loadingTimer = undefined
    return loading !== undefined
  }

  /** Choosing is categorical, so it only ticks when the candidate changes; the click train that follows angle and distance starts once a dimension is taken. */
  function startBed(knob: FutureKnob) {
    if (!knob.dimension) return
    knob.sound.bed?.stop()
    knob.sound.lastDrag = undefined
    knob.sound.bed = sounds.bed(positionOf(knob), strengthOf(knob), knob.point.x)
  }

  function startTracking(knob: FutureKnob) {
    stopTracking(knob)
    knob.tracking = { control: labelOf(knob, knob.dimension!), origin: story.text.length, controller: new AbortController() }
    follow(story)
  }

  function stopTracking(knob: FutureKnob) {
    knob.tracking?.controller.abort()
    knob.tracking = undefined
    knob.confidence = undefined
  }

  function pin(knob: FutureKnob, sentence: Span) {
    const { confidence } = knob
    unpark(knob)
    stopTracking(knob)
    knob.confidence = confidence
    knob.pinned = sentence
    knob.element.toggleAttribute("data-pinned", true)
  }

  /** A dropped knob the text has grown over moves out of the way, into the right gutter, so it never hides the words; it keeps steering until it pins. */
  function parkCovered() {
    const text = textBox()
    if (!text) return
    for (const knob of knobs) {
      if (!knob.dimension || knob.pinned || knob.isDragging || knob.parkedAt !== undefined) continue
      const radius = knob.element.offsetWidth / 2
      const { x, y } = knob.point
      if (x + radius > text.left && x - radius < text.right && y + radius > text.top && y - radius < text.bottom) {
        knob.parkedAt = y
        knob.element.toggleAttribute("data-parked", true)
      }
    }
  }

  function unpark(knob: FutureKnob) {
    knob.parkedAt = undefined
    knob.element.removeAttribute("data-parked")
  }

  /** The page box of the shown text, or undefined while there is none. */
  function textBox() {
    const range = document.createRange()
    range.selectNodeContents(textElement)
    const { left, right, top, bottom, width } = range.getBoundingClientRect()
    return width ? { left: left + scrollX, right: right + scrollX, top: top + scrollY, bottom: bottom + scrollY } : undefined
  }

  /** Pinned knobs sit level with their sentence, parked ones level with where they were; both in the right gutter, stacked so none overlap. */
  function placeInGutter() {
    const placed = knobs.filter((knob) => knob.pinned || knob.parkedAt !== undefined)
    const points = placeInRightMargin(
      placed.map((knob) => ({
        anchor: knob.pinned ? anchorOf(knob.pinned) : { x: knob.point.x, y: knob.parkedAt! },
        element: knob.element,
        label: knob.label,
      })),
      textElement.getBoundingClientRect().right + scrollX,
    )
    points.forEach((point, i) => {
      placed[i].point = point
      placed[i].element.dataset.side = "right"
    })
  }

  /** The page point of the sentence's first character. */
  function anchorOf(sentence: Span): Point {
    const [first] = rangeOf({ start: sentence.start, end: sentence.start + 1 }).getClientRects()
    return first ? { x: first.left + scrollX, y: first.top + scrollY + first.height / 2 } : { x: 0, y: 0 }
  }

  function rangeOf({ start, end }: Span) {
    const range = document.createRange()
    range.setStart(...domPointAt(textElement, start))
    range.setEnd(...domPointAt(textElement, Math.min(end, story.text.length)))
    return range
  }

  function drag(knob: FutureKnob, point: Point) {
    const main = circleOf(mainKnob)
    const dx = point.x - main.center.x
    const dy = point.y - main.center.y
    knob.point = point
    knob.place = { swing: wrapped(Math.atan2(dx, dy) - axis), distance: Math.hypot(dx, dy) }
    const candidate = knob.candidate
    updateCandidate(knob)
    if (!knob.dimension && knob.candidate !== undefined && knob.candidate !== candidate) sounds.candidate(knob.candidate, point.x)
    soundTuning(knob)
    layout()
    settle(knob)
  }

  /** Ticks as a tuned knob crosses graduations, options or steps of strength, and feeds the drag's click train. */
  function soundTuning(knob: FutureKnob) {
    const { sound, dimension, point } = knob
    const now = performance.now()
    const { lastDrag } = sound
    const speed = lastDrag ? Math.hypot(point.x - lastDrag.point.x, point.y - lastDrag.point.y) / Math.max(1, now - lastDrag.at) / DRAG_SPEED_FULL : 0
    sound.lastDrag = { point, at: now }
    const position = positionOf(knob)
    const strength = strengthOf(knob)
    sound.bed?.move(position, strength, clamp01(speed), point.x)
    if (!dimension) return

    const marks = {
      graduation: Math.round(position * GRADUATIONS),
      option: dimension.kind === "choice" ? optionIndexAt(dimension.options.length, position) : 0,
      step: Math.min(RULER_STEPS, Math.floor(strength * RULER_STEPS)),
    }
    const previous = sound.marks
    sound.marks = marks
    if (!previous) return
    if (dimension.kind === "scale" && marks.graduation !== previous.graduation) {
      const direction = Math.sign(marks.graduation - previous.graduation)
      const crossed = Math.min(MAX_TICKS_PER_MOVE, Math.abs(marks.graduation - previous.graduation))
      for (let i = 1; i <= crossed; i++) {
        const graduation = previous.graduation + direction * i
        sounds.graduation(graduation / GRADUATIONS, graduation % NUMBERED_EVERY === 0, point.x)
      }
    }
    if (marks.option !== previous.option) sounds.sector(marks.option, point.x)
    if (marks.step !== previous.step) {
      const crossed = marks.step > previous.step ? marks.step : previous.step
      if (crossed > 0) sounds.ruler(crossed, RULER_STEPS, point.x)
    }
  }

  function drop(knob: FutureKnob) {
    knob.isDragging = false
    knob.sound.bed?.stop()
    knob.sound.bed = undefined
    if (!knobs.includes(knob)) return
    if (!knob.dimension || knob.place.distance < minDistanceOf(knob, circleOf(mainKnob).radius)) return remove(knob)
    if (knob.sound.hasMoved) sounds.handOff(knob.point.x)
    startTracking(knob)
  }

  /** While choosing, the dimension in the knob's direction is the candidate, and carrying the knob through the gate chooses it. */
  function updateCandidate(knob: FutureKnob) {
    if (knob.dimension) return
    const beyondTouching = knob.place.distance - minDistanceOf(knob, circleOf(mainKnob).radius)
    knob.candidate = knob.menu && beyondTouching >= MENU_DEAD_ZONE_PX ? optionIndexAt(knob.menu.length, positionOf(knob)) : undefined
    knob.progress = clamp01(beyondTouching / MENU_GATE_PX)
    if (knob.candidate !== undefined && beyondTouching >= MENU_GATE_PX) choose(knob, knob.menu![knob.candidate])
  }

  function choose(knob: FutureKnob, dimension: Dimension) {
    knob.dimension = dimension
    knob.candidate = undefined
    knob.sound.marks = undefined
    sounds.take(knob.point.x)
    if (knob.isDragging) startBed(knob)
    layout()
    settle(knob)
  }

  /** Reports a change only when what the text generator would see differs from the last report. */
  function settle(knob: FutureKnob) {
    const setting = knob.dimension && `${valueOf({ dimension: knob.dimension, position: positionOf(knob) })}|${strengthLevelOf(strengthOf(knob))}`
    if (setting === knob.setting) return
    knob.setting = setting
    onChange()
  }

  /** The label goes on the side away from the main knob, so it stays off the link. */
  function placeOnPage(knob: FutureKnob, origin: Point) {
    const size = knob.element.offsetWidth
    const { x, y } = knob.point
    knob.element.style.translate = `${x - size / 2}px ${y - size / 2}px`
    if (!knob.pinned && knob.parkedAt === undefined) knob.element.dataset.side = x < origin.x ? "left" : "right"
  }

  /** Updates the knob's look and returns what its HUD readout shows. */
  function show(knob: FutureKnob): ReadoutPart[] {
    const { dimension, element } = knob
    element.toggleAttribute("data-dragging", knob.isDragging)
    element.toggleAttribute("data-loading", !dimension && !knob.menu)
    element.toggleAttribute("data-tuned", dimension !== undefined)
    if (!dimension) {
      element.style.setProperty("--fill", `${knob.progress}`)
      labelWith(knob.label, PENDING_VALUE)
      element.setAttribute("aria-label", `future knob, choosing a dimension, double click to delete`)
      if (!knob.menu) return [{ text: PENDING_VALUE, tone: "live" }]
      return knob.candidate === undefined ? [] : [{ text: previewOf(knob.menu[knob.candidate]) }]
    }
    const strength = strengthOf(knob)
    const value = valueOf({ dimension, position: positionOf(knob) })
    const percent = `${Math.round(strength * 100)}%`
    const realized = knob.confidence === undefined ? "" : `${Math.round(knob.confidence * 100)}%${knob.pinned ? "" : " realized"}`
    const isRealizing = knob.tracking !== undefined || knob.pinned !== undefined
    element.style.setProperty("--fill", `${isRealizing ? (knob.confidence ?? 0) : strength}`)
    element.toggleAttribute("data-tracking", knob.tracking !== undefined)
    labelWith(knob.label, `${dimension.name}: ${value}`, realized)
    const state = knob.pinned ? "realized and pinned beside its sentence" : `${strengthLevelOf(strength)} influence${realized && `, ${realized}`}`
    element.setAttribute("aria-label", `future knob, ${dimension.name}: ${value}, ${state}, double click to delete`)
    return [{ text: `${dimension.name}:`, tone: "dim" }, { text: value, tone: "live" }, { text: realized ? `${percent} · ${realized}` : percent }]
  }

  function viewOf(knob: FutureKnob) {
    if (knob.dimension) return { phase: "tuning" as const, dimension: knob.dimension, swing: clampedSwingOf(knob) }
    return { phase: "choosing" as const, names: knob.menu?.map(({ name }) => name) ?? [], candidate: knob.candidate }
  }

  function labelOf(knob: FutureKnob, dimension: Dimension) {
    return `${dimension.name}: ${valueOf({ dimension, position: positionOf(knob) })}`
  }

  function positionOf(knob: FutureKnob) {
    return clamp01((knob.place.swing + SWING_RADIANS) / (2 * SWING_RADIANS))
  }

  function strengthOf(knob: FutureKnob) {
    const min = minDistanceOf(knob, circleOf(mainKnob).radius)
    return clamp01((knob.place.distance - min) / STRENGTH_RANGE_PX)
  }

  function clampedSwingOf(knob: FutureKnob) {
    return positionOf(knob) * 2 * SWING_RADIANS - SWING_RADIANS
  }
}

/**
 * Calls `onDouble` on a double click whose two presses both landed on `element`. A knob spawned by a Shift press on the main knob captures
 * that pointer, so two quick Shift presses deliver a double click to it on release; that one must not delete it.
 */
function onDoubleClick(element: HTMLElement, onDouble: () => void) {
  let presses: number[] = []
  element.addEventListener("pointerdown", ({ timeStamp }) => (presses = [...presses.slice(-1), timeStamp]))
  element.addEventListener("dblclick", ({ timeStamp }) => {
    const [first, second] = presses
    if (presses.length === 2 && second - first <= DOUBLE_CLICK_MS && timeStamp - second <= DOUBLE_CLICK_MS) onDouble()
  })
}

function isSteering(knob: FutureKnob) {
  return knob.dimension !== undefined && !knob.pinned
}

function previewOf(dimension: Dimension) {
  const offer = dimension.kind === "scale" ? `${dimension.low} ↔ ${dimension.high}` : dimension.options.join(" · ")
  return `${dimension.name}: ${offer}`
}

/** Writes `text` into a knob's label, followed by `detail` set apart in a `<b>`. */
function labelWith(label: HTMLElement, text: string, detail = "") {
  const parts: (string | Node)[] = [text]
  if (detail) parts.push(" ", Object.assign(document.createElement("b"), { textContent: detail }))
  label.replaceChildren(...parts)
}

function rimRadiusOf(knob: Pick<FutureKnob, "element">, mainRadius: number) {
  return minDistanceOf(knob, mainRadius) + STRENGTH_RANGE_PX
}

function minDistanceOf({ element }: Pick<FutureKnob, "element">, mainRadius: number) {
  return mainRadius + element.offsetWidth / 2
}

function wrapped(angle: number) {
  return Math.atan2(Math.sin(angle), Math.cos(angle))
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value))
}
