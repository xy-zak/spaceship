import { STATIONS, type Station } from "../stations.ts"
import { sentenceSpans } from "../text/segments.ts"
import { floorOf, joinTurns, tidySpace, wordsOf, type Turn } from "../turn-rules.ts"

/** `wordLimit` is how many new words a turn may add, null for no limit. */
export type TurnState = { active: Station; turns: Turn[]; wordLimit: number | null }
/** `claim` is the one the live text was planned to make, as "move: claim". */
export type Live = { station: Station; tail: string; steering: string[]; claim?: string }
export type TurnEvent = { type: "state"; state: TurnState } | { type: "live"; live: Live } | { type: "offline" }

const LIVE_MS = 200
/** The server pings every 15 s, so this long without any event means the stream died without an error. */
const WATCHDOG_MS = 45_000
const MIN_LOCKED_WORDS = 200
/** Keeps the prompt inside Ollama's 16k context; it would otherwise drop the start silently. */
const MAX_HEAD_WORDS = 6000
const JSON_HEADERS = { "Content-Type": "application/json" }

export function stationOf(search: string): Station | undefined {
  const station = new URLSearchParams(search).get("station")
  return STATIONS.find((known) => known === station)
}

/** `/api/events` as one stream; EventSource reconnects after an error, and the watchdog reopens a stream that went quiet. */
export async function* turnEvents(signal?: AbortSignal): AsyncGenerator<TurnEvent> {
  const queue: TurnEvent[] = []
  let wake = () => {}
  let source: EventSource | undefined
  let watchdog = 0
  const push = (event: TurnEvent) => {
    queue.push(event)
    wake()
  }
  const restartWatchdog = () => {
    clearTimeout(watchdog)
    watchdog = setTimeout(open, WATCHDOG_MS)
  }
  const open = () => {
    source?.close()
    source = new EventSource("/api/events")
    source.addEventListener("state", (event) => push({ type: "state", state: JSON.parse((event as MessageEvent).data) }))
    source.addEventListener("live", (event) => push({ type: "live", live: JSON.parse((event as MessageEvent).data) }))
    source.addEventListener("error", () => push({ type: "offline" }))
    for (const type of ["state", "live", "ping"]) source.addEventListener(type, restartWatchdog)
    restartWatchdog()
  }

  open()
  signal?.addEventListener("abort", () => wake())
  try {
    while (!signal?.aborted) {
      const event = queue.shift()
      if (event) yield event
      else await new Promise<void>((resolve) => (wake = resolve))
    }
  } finally {
    clearTimeout(watchdog)
    source?.close()
  }
}

/** Posts only what changed, one request at a time and at most every 200 ms, the latest text winning. Failures are ignored: the next change retries. */
export function createLivePoster(station: Station) {
  let latest = ""
  let sent = ""
  let isBusy = false
  return (tail: string, steering: string[], claim?: string) => {
    latest = JSON.stringify({ station, tail, steering, claim })
    if (!isBusy) flush()
  }

  async function flush() {
    if (latest === sent) return
    isBusy = true
    sent = latest
    await fetch("/api/live", { method: "POST", headers: JSON_HEADERS, body: sent }).catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, LIVE_MS))
    isBusy = false
    flush()
  }
}

/** `refused` means the turn already moved on (a double commit or a skip), so the caller waits for the new state like after `done`. */
export async function commitTurn(station: Station, tail: string, claim?: string): Promise<"done" | "refused" | "failed"> {
  try {
    const response = await fetch("/api/commit", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ station, tail, claim }) })
    return response.ok ? "done" : response.status === 409 ? "refused" : "failed"
  } catch {
    return "failed"
  }
}

export function swapTo(page: "editor" | "view") {
  location.replace(`${import.meta.env.BASE_URL}${page === "view" ? "view.html" : ""}${location.search}`)
}

/**
 * What the editor shows: the last turn, which may be rewritten, after the locked text from the start of the sentence that holds the
 * `minLockedWords`-th locked word from the end. The locked text before that is the `head`, which only the model sees, capped at its last 6,000 words.
 */
export function visibleWindow(turns: Turn[], minLockedWords = MIN_LOCKED_WORDS) {
  const locked = joinTurns(floorOf(turns))
  const last = turns.length > 1 ? turns[turns.length - 1].text : ""
  const lockedWords = [...locked.matchAll(/\S+/g)]
  const firstShown = lockedWords[lockedWords.length - minLockedWords]?.index ?? 0
  const cut = sentenceSpans(locked).find(({ end }) => end > firstShown)?.start ?? 0
  const shownLocked = locked.slice(cut)
  return {
    head: wordsOf(locked.slice(0, cut)).slice(-MAX_HEAD_WORDS).join(" "),
    text: tidySpace(`${shownLocked} ${last}`),
    floorWords: wordsOf(shownLocked).length,
  }
}
