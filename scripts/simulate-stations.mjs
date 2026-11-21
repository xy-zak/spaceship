import { MODEL, STATIONS } from "../src/stations.ts"
import { startMockOllama } from "./simulation/mock-ollama.mjs"
import { runStation } from "./simulation/station.mjs"

/**
 * Plays the installation without Pis, panels or a GPU: `npm run simulate [-- B C D]` while `npm run dev` runs.
 * Each named station (all three by default) watches /api/events and plays its turns through /api/live, /api/commit and the /ollama proxy.
 * A mock Ollama answers on 127.0.0.1:11434 unless something already listens there (a real Ollama, or another simulate process).
 * With a real Ollama running, give both commands another port: `OLLAMA_PORT=11435 npm run dev` and `OLLAMA_PORT=11435 npm run simulate`.
 * Run stations in separate terminals to kill one mid-turn; set BASE=http://localhost:4173 to drive `npm run preview` instead.
 * MODEL=qwen3-vl:8b-instruct asks a real Ollama for another model than the installation's.
 */
const BASE = process.env.BASE ?? "http://localhost:5173"
const model = process.env.MODEL ?? MODEL
const stations = process.argv.length > 2 ? process.argv.slice(2) : STATIONS
const unknown = stations.filter((station) => !STATIONS.includes(station))
if (unknown.length) throw new Error(`unknown stations ${unknown.join(" ")}; expected some of ${STATIONS.join(" ")}`)

const ollamaPort = process.env.OLLAMA_PORT ?? 11434
const mock = await startMockOllama(log, model)
log("ollama", mock ? `mock listening on 127.0.0.1:${ollamaPort}` : `port ${ollamaPort} is taken, so model calls go to whatever listens there`)
log("sim", `stations ${stations.join(" ")} against ${BASE}, model ${model}`)
await Promise.all(stations.map((station) => runStation({ base: BASE, station, model, log })))

function log(source, message) {
  console.log(`${new Date().toISOString().slice(11, 23)} ${source.padEnd(6)} ${message}`)
}
