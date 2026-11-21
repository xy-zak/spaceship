import { showArgument } from "../argument.ts"
import { createAuthorMarks } from "../author-marks.ts"
import { $, $$ } from "../dom.ts"
import { stationOf, swapTo, turnEvents, type Live, type TurnState } from "../net/turns.ts"
import { LENSES, nextStation, type Station } from "../stations.ts"
import { appendTail, type Turn } from "../turn-rules.ts"

const station = stationOf(location.search)
const banner = $<HTMLOutputElement>("#banner")
const manifesto = $("#manifesto")
const steering = $<HTMLOutputElement>("#steering")
const argument = $<HTMLOListElement>("#argument")
const drawAuthorMarks = createAuthorMarks($<SVGGElement>("#author-brackets"), $("#bookmarks"))
let state: TurnState | undefined

addEventListener("resize", markAuthors)

for await (const event of turnEvents()) {
  if (event.type === "offline") show(banner, "reconnecting…")
  else if (event.type === "state") {
    if (event.state.active === station) swapTo("editor")
    state = event.state
    render(state)
  } else if (state && event.live.station === state.active) render(state, event.live)
}

/** The live text replaces the last turn the way a commit would, so its words that match the last turn keep that author's shade. */
function render({ active, turns, wordLimit }: TurnState, live?: Live) {
  show(banner, `${active} is writing · ${LENSES[active]}${station && nextStation(active) === station ? " · next: you" : ""}`)
  banner.dataset.station = active
  show(steering, live?.steering.join(" · ") ?? "")
  const shown = live ? appendTail(turns, live.station, live.tail, wordLimit, live.claim) : turns
  showArgument(argument, shown, { isLive: live !== undefined })
  const spans = shown.flatMap((turn, index) => (turn.text ? [spanOf(turn, live !== undefined && index === shown.length - 1)] : []))
  manifesto.replaceChildren(...spans.flatMap((span, index) => (index ? [" ", span] : [span])))
  markAuthors()
  scrollTo({ top: document.documentElement.scrollHeight })
}

/** The opening is left unmarked, and the live text stays open until it is committed. */
function markAuthors() {
  const spans = $$<HTMLElement>("#manifesto [data-station]:not([data-station='opening'])")
  const blocks = spans.map((span) => {
    const range = document.createRange()
    range.selectNodeContents(span)
    return { station: span.dataset.station as Station, range, isOpen: span.hasAttribute("data-live") }
  })
  drawAuthorMarks(blocks, manifesto.getBoundingClientRect().left + scrollX)
}

/** Writes only on a change, so screen readers don't announce the same banner five times a second. */
function show(output: HTMLOutputElement, text: string) {
  if (output.value !== text) output.value = text
}

function spanOf({ station, text }: Turn, isLive: boolean) {
  const span = document.createElement("span")
  span.dataset.station = station
  span.toggleAttribute("data-live", isLive)
  span.textContent = text
  return span
}
