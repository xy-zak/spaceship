import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { DEFAULT_WORD_LIMIT, OPENING, STATIONS, WORD_LIMITS, nextStation } from "../src/stations.ts"
import { appendTail } from "../src/turn-rules.ts"

const MAX_BODY_CHARS = 256 * 1024
const MAX_TAIL_CHARS = 50_000
const MAX_STEERING_LINES = 16
const MAX_STEERING_CHARS = 200
const PING_MS = 15_000
/** A station this far behind on events has a dead connection; dropping it makes it reconnect. */
const MAX_BACKLOG_BYTES = 1_000_000
const LOCAL_ADDRESSES = ["127.0.0.1", "::1", "::ffff:127.0.0.1"]

/** Adds the turn routes to both `vite` and `vite preview`, ahead of Vite's own middleware. `wordLimit` names one of `WORD_LIMITS`. */
export function turns({ file, wordLimit }) {
  return {
    name: "turns",
    configureServer(server) {
      server.middlewares.use(createTurnServer(file, wordLimit))
    },
    configurePreviewServer(server) {
      server.middlewares.use(createTurnServer(file, wordLimit))
    },
  }
}

/**
 * Owns the turn state, the live text and the event streams; returns a connect-style `(req, res, next)` handler for `/api/*`.
 * Every state it sends carries the word limit, which is configuration and so is not saved with the manifesto.
 */
export function createTurnServer(file, wordLimitName = DEFAULT_WORD_LIMIT) {
  if (!Object.hasOwn(WORD_LIMITS, wordLimitName))
    throw new Error(`WORD_LIMIT "${wordLimitName}" is unknown; expected one of ${Object.keys(WORD_LIMITS).join(", ")}`)
  const wordLimit = WORD_LIMITS[wordLimitName]
  let state = loadState(file)
  let live
  const clients = new Set()

  const routes = {
    "GET /api/events": subscribe,
    "POST /api/live": async (req, res) => {
      const body = await readJson(req)
      refuseUnless(isStation(body?.station) && isTail(body.tail) && isSteering(body.steering), 400, "expected { station, tail, steering }")
      refuseUnlessActive(body.station)
      live = { station: body.station, tail: body.tail, steering: body.steering }
      broadcast("live", live)
      res.writeHead(204).end()
    },
    "POST /api/commit": async (req, res) => {
      const body = await readJson(req)
      refuseUnless(isStation(body?.station) && isTail(body.tail), 400, "expected { station, tail }")
      refuseUnlessActive(body.station)
      send(res, 200, change(applyCommit(state, body.station, body.tail, wordLimit)))
    },
    "POST /api/skip": (req, res) => {
      refuseUnless(isLocal(req), 403, "localhost only")
      send(res, 200, change({ ...state, active: nextStation(state.active) }))
    },
    "POST /api/reset": (req, res) => {
      refuseUnless(isLocal(req), 403, "localhost only")
      if (existsSync(file)) copyFileSync(file, stamped(file, ""))
      send(res, 200, change(initialState()))
    },
  }

  return async (req, res, next) => {
    const path = req.url.split("?")[0]
    if (!path.startsWith("/api/")) return next()
    try {
      const route = routes[`${req.method} ${path}`]
      refuseUnless(route, 404, "not found")
      await route(req, res)
    } catch (error) {
      if (!error.status) console.error("[turns]", error)
      send(res, error.status ?? 500, { error: error.status ? error.message : "server error, nothing changed", ...error.extra })
    }
  }

  function subscribe(req, res) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" })
    res.write(`retry: 1000\n\n${frame("state", withWordLimit(state))}${live ? frame("live", live) : ""}`)
    clients.add(res)
    const ping = setInterval(() => res.write("event: ping\ndata:\n\n"), PING_MS)
    // res, not req: req's "close" fires as soon as its (empty) body is read
    res.on("close", () => {
      clearInterval(ping)
      clients.delete(res)
    })
  }

  function refuseUnlessActive(station) {
    if (station !== state.active) throw refusal(409, "not active", { active: state.active })
  }

  /** Saves first, so a failed save leaves memory and every station untouched. */
  function change(next) {
    saveState(file, next)
    state = next
    live = undefined
    const sent = withWordLimit(state)
    broadcast("state", sent)
    return sent
  }

  function withWordLimit(state) {
    return { ...state, wordLimit }
  }

  function broadcast(type, data) {
    const message = frame(type, data)
    for (const client of clients) {
      if (client.writableLength > MAX_BACKLOG_BYTES) client.destroy()
      else client.write(message)
    }
  }
}

function loadState(file) {
  if (!existsSync(file)) return initialState()
  const state = parseState(readFileSync(file, "utf8"))
  if (state) return state
  const aside = stamped(file, "corrupt-")
  renameSync(file, aside)
  console.warn(`[turns] ${file} could not be read as a manifesto, moved to ${aside}; starting from the opening`)
  return initialState()
}

function saveState(file, state) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { flush: true })
  renameSync(temp, file)
}

async function readJson(req) {
  let body = ""
  for await (const chunk of req.setEncoding("utf8")) {
    body += chunk
    if (body.length > MAX_BODY_CHARS) throw refusal(413, "body over 256K characters")
  }
  try {
    return JSON.parse(body)
  } catch {
    throw refusal(400, "body is not JSON")
  }
}

function refuseUnless(condition, status, message) {
  if (!condition) throw refusal(status, message)
}

const refusal = (status, message, extra) => Object.assign(new Error(message), { status, extra })

const send = (res, status, data) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(data))

const frame = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`

const stamped = (file, label) => file.replace(/\.json$/, `-${label}${new Date().toISOString().replace(/[:.]/g, "-")}.json`)

const isLocal = (req) => LOCAL_ADDRESSES.includes(req.socket.remoteAddress)

const initialState = () => ({ active: STATIONS[0], turns: [{ station: "opening", text: OPENING }] })

/** Pure: credits the tail's leading words that match the last turn to that turn, appends the rest (at most `wordLimit` words) as the new turn, and passes the turn on. */
export const applyCommit = ({ turns }, station, tail, wordLimit = null) => ({
  active: nextStation(station),
  turns: appendTail(turns, station, tail, wordLimit),
})

function parseState(json) {
  try {
    const state = JSON.parse(json)
    return isState(state) ? state : undefined
  } catch {
    return undefined
  }
}

const isStation = (value) => STATIONS.includes(value)

const isTail = (value) => typeof value === "string" && value.length <= MAX_TAIL_CHARS

const isSteering = (value) =>
  Array.isArray(value) && value.length <= MAX_STEERING_LINES && value.every((line) => typeof line === "string" && line.length <= MAX_STEERING_CHARS)

const isState = (value) =>
  isStation(value?.active) &&
  Array.isArray(value.turns) &&
  value.turns.length > 0 &&
  value.turns.every((turn, index) => typeof turn?.text === "string" && (index === 0 ? turn.station === "opening" : isStation(turn.station)))
