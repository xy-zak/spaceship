import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { turnEvents } from "../scripts/simulation/event-stream.mjs"
import { nextStation } from "../src/stations.ts"
import { applyCommit, createTurnServer } from "./turns.mjs"

const opening = { station: "opening", text: "Design education must" }
/** A state as the server sends it: with the default word limit, which is not saved. */
const sent = (state) => ({ ...state, wordLimit: 100 })

test("commit split", () => {
  const cases = [
    // previous turn, tail, previous turn after, new turn
    [undefined, "teach doubt", undefined, "teach doubt"],
    [
      "teach doubt before style. Every brief should end on a portfolio piece.",
      "teach doubt before style. Every brief should end with a question the client did not ask.",
      "teach doubt before style. Every brief should end",
      "with a question the client did not ask.",
    ],
    ["teach doubt before style.", "", "", ""],
    ["teach doubt before style.", " \n\t ", "", ""],
    ["teach doubt before style.", "teach doubt", "teach doubt", ""],
    ["teach doubt before style.", "teach doubt before style.", "teach doubt before style.", ""],
    ["teach doubt before style.", "learn doubt before", "", "learn doubt before"],
    ["teach doubt before style.", "teach doubt before style Every", "teach doubt before", "style Every"],
    ["teach doubt before style.", "teach doubt\n\nbefore   style.\n \nGrades ", "teach doubt\n\nbefore style.", "\n\nGrades"],
    ["teach doubt.", "\n\nteach doubt. Grades", "\n\nteach doubt.", "Grades"],
    ["", "a b", "", "a b"],
  ]
  for (const [previous, tail, previousAfter, fresh] of cases) {
    const turns = previous === undefined ? [opening] : [opening, { station: "B", text: previous }]
    const expected = previous === undefined ? [opening] : [opening, { station: "B", text: previousAfter }]
    const active = previous === undefined ? "B" : "C"
    assert.deepEqual(applyCommit({ active, turns }, active, tail), {
      active: nextStation(active),
      turns: [...expected, { station: active, text: fresh }],
    })
  }
})

test("a turn keeps the claim it was planned to make, unless it adds no words", () => {
  const turns = [opening, { station: "B", text: "teach doubt.", claim: "thesis: Design education must teach doubt." }]
  assert.deepEqual(applyCommit({ active: "C", turns }, "C", "teach doubt. Grades lie.", null, "diagnose: Grades lie.").turns.slice(1), [
    { station: "B", text: "teach doubt.", claim: "thesis: Design education must teach doubt." },
    { station: "C", text: "Grades lie.", claim: "diagnose: Grades lie." },
  ])
  assert.deepEqual(applyCommit({ active: "C", turns }, "C", "teach doubt.", null, "diagnose: Grades lie.").turns.at(-1), { station: "C", text: "" })
})

test("a turn adds at most its word limit, after the words it keeps", async (t) => {
  const turns = [opening, { station: "B", text: "teach doubt." }]
  assert.deepEqual(applyCommit({ active: "C", turns }, "C", "teach doubt.\n\nGrades lie about it", 2).turns.slice(1), [
    { station: "B", text: "teach doubt." },
    { station: "C", text: "\n\nGrades lie" },
  ])
  assert.deepEqual(applyCommit({ active: "C", turns }, "C", "teach doubt. Grades", 2).turns.at(-1), { station: "C", text: "Grades" })

  const file = join(mkdtempSync(join(tmpdir(), "turns-")), "manifesto.json")
  assert.throws(() => createTurnServer(file, "huge"), /WORD_LIMIT "huge" is unknown/)
  assert.throws(() => createTurnServer(file, "toString"), /is unknown/)
  const { base } = await startServer(t, file, "short")
  const words = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ")
  const { body } = await post(base, "/api/commit", { station: "B", tail: words })
  assert.equal(body.wordLimit, 50)
  assert.equal(body.turns.at(-1).text, words.split(" ").slice(0, 50).join(" "))
  const unlimited = await startServer(t, join(mkdtempSync(join(tmpdir(), "turns-")), "manifesto.json"), "unlimited")
  assert.equal((await post(unlimited.base, "/api/commit", { station: "B", tail: words })).body.turns.at(-1).text, words)
})

test("turns rotate B → C → D → B", () => {
  assert.deepEqual(["B", "C", "D"].map(nextStation), ["C", "D", "B"])
})

test("events start with state and relay live and commit", async (t) => {
  const { base } = await startServer(t)
  const controller = new AbortController()
  t.after(() => controller.abort())
  const watcher = turnEvents(`${base}/api/events`, controller.signal)
  const started = { type: "state", data: sent({ active: "B", turns: [opening] }) }
  assert.deepEqual((await watcher.next()).value, started)

  const live = { station: "B", tail: "teach doubt", steering: ["stance: very radical (strong)"], claim: "thesis: Design education must teach doubt." }
  assert.equal((await post(base, "/api/live", live)).status, 204)
  assert.deepEqual((await watcher.next()).value, { type: "live", data: live })
  assert.deepEqual(await events(base, 2), [started, { type: "live", data: live }])

  const committed = sent({ active: "C", turns: [opening, { station: "B", text: "teach doubt" }] })
  assert.deepEqual(await post(base, "/api/commit", { station: "B", tail: "teach doubt" }), { status: 200, body: committed })
  assert.deepEqual((await watcher.next()).value, { type: "state", data: committed })
  assert.deepEqual(await events(base, 1), [{ type: "state", data: committed }])

  assert.deepEqual(await post(base, "/api/commit", { station: "B", tail: "again" }), {
    status: 409,
    body: { error: "not active", active: "C" },
  })
})

test("refuses bad posts", async (t) => {
  const { base } = await startServer(t)
  const status = async (path, body) => (await post(base, path, body)).status
  assert.equal(await status("/api/live", { station: "C", tail: "", steering: [] }), 409)
  assert.equal(await status("/api/live", { station: "C", tail: 3, steering: [] }), 400)
  assert.equal(await status("/api/live", { station: "Z", tail: "", steering: [] }), 400)
  assert.equal(await status("/api/live", { station: "B", tail: "", steering: Array(17).fill("x") }), 400)
  assert.equal(await status("/api/live", { station: "B", tail: "", steering: ["x".repeat(201)] }), 400)
  assert.equal(await status("/api/live", { station: "B", tail: "", steering: [], claim: "x".repeat(401) }), 400)
  assert.equal(await status("/api/commit", "{"), 400)
  assert.equal(await status("/api/commit", null), 400)
  assert.equal(await status("/api/commit", { station: "B", tail: "x".repeat(50_001) }), 400)
  assert.equal(await status("/api/commit", { station: "B", tail: "x".repeat(300_000) }), 413)
  assert.equal(await status("/api/nothing", {}), 404)
  assert.deepEqual(await events(base, 1), [{ type: "state", data: sent({ active: "B", turns: [opening] }) }])
})

test("skip and reset are refused from the LAN", async () => {
  const handle = createTurnServer(join(mkdtempSync(join(tmpdir(), "turns-")), "manifesto.json"))
  for (const url of ["/api/skip", "/api/reset"]) {
    const res = fakeResponse()
    await handle({ method: "POST", url, socket: { remoteAddress: "192.168.1.20" } }, res)
    assert.equal(res.status, 403)
  }
})

test("skip rotates, reset archives and starts again", async (t) => {
  const { base, file } = await startServer(t)
  await post(base, "/api/commit", { station: "B", tail: "teach doubt" })
  assert.equal((await post(base, "/api/skip")).body.active, "D")
  assert.deepEqual((await post(base, "/api/reset")).body, sent({ active: "B", turns: [opening] }))
  const archive = readdirSync(dirname(file)).find((name) => /^manifesto-\d{4}-.*\.json$/.test(name))
  assert.equal(JSON.parse(readFileSync(join(dirname(file), archive), "utf8")).active, "D")
})

test("a restart keeps the manifesto", async (t) => {
  const { base, file, close } = await startServer(t)
  const { body } = await post(base, "/api/commit", { station: "B", tail: "teach doubt" })
  close()
  const { wordLimit, ...saved } = body
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), saved)
  const restarted = await startServer(t, file)
  assert.deepEqual(await events(restarted.base, 1), [{ type: "state", data: body }])
})

test("a failed save changes nothing", async (t) => {
  const { base, file } = await startServer(t)
  mkdirSync(`${file}.tmp`)
  assert.equal((await post(base, "/api/commit", { station: "B", tail: "teach doubt" })).status, 500)
  assert.deepEqual(await events(base, 1), [{ type: "state", data: sent({ active: "B", turns: [opening] }) }])
  rmSync(`${file}.tmp`, { recursive: true })
  assert.equal((await post(base, "/api/commit", { station: "B", tail: "teach doubt" })).status, 200)
})

test("a data folder deleted while running comes back on the next save", async (t) => {
  const { base, file } = await startServer(t)
  rmSync(dirname(file), { recursive: true })
  assert.equal((await post(base, "/api/commit", { station: "B", tail: "teach doubt" })).status, 200)
  assert.equal(JSON.parse(readFileSync(file, "utf8")).active, "C")
})

test("a corrupt file is moved aside, never overwritten", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "turns-"))
  const file = join(dir, "manifesto.json")
  writeFileSync(file, "{ half a manifesto")
  t.mock.method(console, "warn", () => {})
  const { base } = await startServer(t, file)
  assert.deepEqual(await events(base, 1), [{ type: "state", data: sent({ active: "B", turns: [opening] }) }])
  const aside = readdirSync(dir).find((name) => name.startsWith("manifesto-corrupt-"))
  assert.equal(readFileSync(join(dir, aside), "utf8"), "{ half a manifesto")
})

async function startServer(t, file = join(mkdtempSync(join(tmpdir(), "turns-")), "manifesto.json"), wordLimit) {
  t.mock.method(console, "error", () => {})
  const handle = createTurnServer(file, wordLimit)
  const server = createServer((req, res) => handle(req, res, () => res.writeHead(404).end()))
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const close = () => {
    server.close()
    server.closeAllConnections()
  }
  t.after(close)
  return { base: `http://127.0.0.1:${server.address().port}`, file, close }
}

/** The first `count` events of a fresh `/api/events` connection. */
async function events(base, count) {
  const controller = new AbortController()
  const received = []
  for await (const event of turnEvents(`${base}/api/events`, controller.signal)) {
    received.push(event)
    if (received.length === count) break
  }
  controller.abort()
  return received
}

async function post(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : undefined }
}

function fakeResponse() {
  return {
    writeHead(status) {
      this.status = status
      return this
    },
    end() {},
  }
}
