import type { StreamActivity } from "./text-stream.ts"

/**
 * What the model is doing, and what the text holds and is steered by; `buffer` counts the generated words waiting past the knob,
 * and `turn` the new words this turn adds, against its limit (null for none), when the editor plays a station.
 */
export type Status = StreamActivity & {
  words: number
  buffer: number
  boxes: number
  steering: number
  pinned: number
  turn?: { words: number; limit: number | null }
}

/**
 * Writes `status` into `element` as three zones: what the model is doing, what the text holds, and what steers it.
 * Whether the model is streaming is marked on `element`, for the readings to show it. Model and text fields are labelled by a glyph that spells out its name on hover; a field not measured yet reads as a dash.
 */
export function showStatus(element: HTMLElement, { isGenerating, firstChunkMs, wordsPerSecond, words, buffer, boxes, steering, pinned, turn }: Status) {
  element.toggleAttribute("data-streaming", isGenerating)
  element.replaceChildren(
    zone(
      field("rate", glyph("»", "rate"), wordsPerSecond === undefined ? undefined : `${Math.round(wordsPerSecond)}`, "w/s"),
      field("latency", glyph("▼", "latency to first chunk"), firstChunkMs === undefined ? undefined : `${Math.round(firstChunkMs)}`, "ms"),
    ),
    zone(
      field("words", glyph("¶", "words, + generated past the knob"), `${words}`, `+${buffer}`),
      ...(turn ? [field("turn", "turn", `${turn.words}`, turn.limit === null ? undefined : `/${turn.limit}`)] : []),
    ),
    zone(field("boxes", "box", `${boxes}`), field("steering", "steer", `${steering}`), field("pinned", "pin", `${pinned}`)),
  )
}

function zone(...fields: HTMLElement[]) {
  const span = document.createElement("span")
  span.className = "zone"
  span.append(...fields)
  return span
}

function field(name: string, label: string | Node, value?: string, suffix?: string) {
  const span = document.createElement("span")
  span.dataset.field = name
  const reading = Object.assign(document.createElement("b"), { textContent: value ?? "—" })
  if (value !== undefined && suffix) reading.append(Object.assign(document.createElement("small"), { textContent: suffix }))
  span.append(label, reading)
  return span
}

function glyph(symbol: string, name: string) {
  return Object.assign(document.createElement("abbr"), { textContent: symbol, title: name })
}
