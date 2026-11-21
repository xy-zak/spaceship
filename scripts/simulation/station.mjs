import assert from "node:assert/strict"
import { setTimeout as sleep } from "node:timers/promises"
import { LENSES, nextStation } from "../../src/stations.ts"
import { floorOf, joinTurns, wordsOf } from "../../src/turn-rules.ts"
import { framesOf, turnEvents } from "./event-stream.mjs"

const LIVE_MS = 200
const OK_HOLD_MS = 1000
const RETRY_MS = 1000
const MAX_NEW_WORDS = 15
/** What a Pi's Chromium sends with every request; the proxy has to replace it before Ollama sees it. */
const PI_ORIGIN = "http://pa.local:4173"
const STEERING = ["stance: very radical (strong)", "tone: hopeful"]

/**
 * One simulated Pi. While waiting it reads the events stream like the view page; on its turn it plays the editor:
 * keeps a random number of the last turn's leading words, writes new ones through the /ollama proxy, posts live text, then commits.
 * Random keep and write counts cover every case of the commit split, empty turns included.
 */
export async function runStation({ base, station, model, log }) {
  let seen
  let turn
  let liveCount = 0

  for await (const event of turnEvents(`${base}/api/events`)) {
    if (event.type === "offline") log(station, `reconnecting… (${event.reason})`)
    if (event.type === "live" && event.data.station !== station) liveCount++
    if (event.type !== "state") continue

    const state = event.data
    // a reconnect that finds the same state leaves the turn alone, like the editor after a server restart
    if (JSON.stringify(state) === JSON.stringify(seen)) continue
    if (seen) assertLockedTurnsKept(seen, state)
    if (liveCount) log(station, `saw ${liveCount} live updates from ${seen.active}`)
    liveCount = 0
    turn?.abort()
    seen = state
    if (state.active !== station) continue

    turn = new AbortController()
    replayUntilDone({ base, station, model, state, log, signal: turn.signal })
  }
}

/** A turn that fails (server down, model down) is played again from the same state, like a player holding OK again. A commit that landed but lost its response gets 409, then the new state ends it. */
async function replayUntilDone(options) {
  while (!options.signal.aborted) {
    try {
      return await playTurn(options)
    } catch (error) {
      if (options.signal.aborted) return
      options.log(options.station, `turn failed (${error.cause?.code ?? error.message}), playing it again in 1 s`)
      await sleep(RETRY_MS, undefined, { signal: options.signal }).catch(() => {})
    }
  }
}

async function playTurn({ base, station, model, state, log, signal }) {
  const lastWords = state.turns.length > 1 ? wordsOf(state.turns.at(-1).text) : []
  const kept = lastWords.slice(0, randomInt(lastWords.length))
  const target = kept.length + randomInt(MAX_NEW_WORDS)
  const floor = joinTurns(floorOf(state.turns))
  log(
    station,
    `my turn · ${LENSES[station]} · floor ${wordsOf(floor).length} words · keeping ${kept.length}/${lastWords.length}, writing ${target - kept.length}`,
  )

  const upToKnob = [floor, ...kept].join(" ")
  // the trailing space keeps a continuation that starts without one off the last kept word, as the editor does
  let text = `${kept.join(" ")} `
  let sent = ""
  let sentAt = -Infinity
  const generation = new AbortController()
  if (target > kept.length) {
    for await (const delta of completion(base, model, upToKnob, AbortSignal.any([signal, generation.signal]))) {
      text += delta
      const tail = wordsOf(text).join(" ")
      if (tail !== sent && performance.now() - sentAt >= LIVE_MS) {
        sent = tail
        sentAt = performance.now()
        await post(base, "/api/live", { station, tail, steering: STEERING }, signal).catch(() => {})
      }
      if (wordsOf(text).length >= target) break
    }
  }
  generation.abort()

  await sleep(OK_HOLD_MS, undefined, { signal })
  const tail = wordsOf(text).join(" ")
  const response = await post(base, "/api/commit", { station, tail }, signal)
  const body = await response.json()
  if (response.status === 409) return log(station, `commit 409, already done or skipped: ${JSON.stringify(body)}`)
  if (!response.ok) throw new Error(`commit ${response.status} ${JSON.stringify(body)}`)
  const [previous, fresh] = body.turns.slice(-2)
  log(station, `commit ${response.status} · ${previous.station}: "${previous.text}" · ${station}: "${fresh.text}" · next ${body.active}`)
}

/** The two rules every commit must keep: locked turns never change, and the turn moves to the next station. Skips, resets and missed events are not checked. */
function assertLockedTurnsKept(previous, next) {
  if (next.turns.length !== previous.turns.length + 1) return
  const floor = floorOf(previous.turns)
  assert.deepEqual(next.turns.slice(0, floor.length), floor, "a locked turn changed")
  assert.equal(next.active, nextStation(previous.active), "the turn skipped a station")
}

async function* completion(base, model, manifesto, signal) {
  const response = await fetch(`${base}/ollama/v1/chat/completions`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Origin: PI_ORIGIN },
    body: JSON.stringify({
      model,
      stream: true,
      reasoning_effort: "low",
      temperature: 0.8,
      max_tokens: 400,
      messages: [
        {
          role: "system",
          content: "Continue this design education manifesto from its last word, which may stop mid-sentence. Reply with only the words that come next.",
        },
        { role: "user", content: manifesto },
      ],
    }),
  })
  if (!response.ok) throw new Error(`model ${response.status} ${await response.text()}`)
  for await (const { data } of framesOf(response.body)) {
    if (data === "[DONE]") return
    const content = JSON.parse(data).choices?.[0]?.delta?.content
    if (content) yield content
  }
}

const post = (base, path, body, signal) =>
  fetch(`${base}${path}`, { method: "POST", signal, headers: { "Content-Type": "application/json", Origin: PI_ORIGIN }, body: JSON.stringify(body) })

/** 0 to max, inclusive. */
const randomInt = (max) => Math.floor(Math.random() * (max + 1))
