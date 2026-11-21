# Network integration review

The server, client and firmware plans in this folder were written separately and then cross-checked against each other. They fit together once the fixes below are applied. **Where `server.md`, `client.md` or `firmware.md` disagree with this file, this file wins.**

- [server.md](server.md): pA, the Vite turns plugin, the Ollama proxy, persistence
- [client.md](client.md): the editor and view pages on the Pis, input, networking, content
- [firmware.md](firmware.md): the ESP32 panel firmware, wiring and parts
- [plan.html](plan.html): the visual overview with the interactive system diagram; open it in a browser

## Checked during the review

- `src/text/words.ts` counts words as `\S+` runs. The server's split and the client's floor and tail all use that rule.
- Vite 8.3.8 (`isHostAllowedInternal`) lets through only `localhost`, `*.localhost` and IP addresses, so `pa.local` must be listed in `server.allowedHosts`. `resolvePreviewOptions` copies `allowedHosts` and `proxy` from `server` to `preview`, so one setting covers both.

## System map

```
ESP32 panel ──serial lines, 115200──▶ Pi: editor page ──POST /api/live, /api/commit──▶ pA: Vite + turns plugin ──▶ data/manifesto.json
                                         │      ▲                                        │
                                         │      └──────────── SSE /api/events ───────────┤
                                         └──POST /ollama/v1/chat/completions──▶ proxy ───┴──▶ Ollama 127.0.0.1:11434
              Pi: view page ◀──────────────────── SSE /api/events (read only, no serial port)
```

## The contract

### Pages and URLs

- Editor: `http://pa.local:4173/spaceship/?station=B&live=true` (C and D likewise). View: `/spaceship/view.html?station=B&live=true`.
- `/api/*` and `/ollama/v1/chat/completions` are at the origin root, not under `/spaceship/`. Only that one Ollama path is proxied.
- Every machine uses the name `pa.local`. The Chromium policy origin, the kiosk URL and `allowedHosts` all depend on it, and Web Serial fails if a Pi opens the raw IP instead. If mDNS fails, map `pa.local` in each Pi's `/etc/hosts`.

### Shared code (erasable TypeScript only, so Vite's config bundler and `node --test` both load it)

```ts
// src/stations.ts: configuration, no imports
export const STATIONS = ["B", "C", "D"] as const
export type Station = (typeof STATIONS)[number]
export const OPENING = "Design education must"
export const MODEL = "gpt-oss:20b"
export const LENSES: Record<Station, string>
export function nextStation(station: Station): Station

// src/turn-rules.ts: the document rules both sides must agree on
import type { Station } from "./stations.ts"
export type Turn = { station: "opening" | Station; text: string }
export const wordsOf = (text: string) => text.match(/\S+/g) ?? []
export function floorOf(turns: Turn[]): Turn[] // turns.length === 1 ? turns : turns.slice(0, -1)
export function joinTurns(turns: Turn[]): string // non-empty texts joined by one space
export function splitTail(turns: Turn[], tail: string): { kept: string; fresh: string }
// kept = the tail's leading words that equal the last turn's leading words ("" when only the opening exists); fresh = the rest
export function appendTail(turns: Turn[], station: Station, tail: string): Turn[]
// the last turn becomes `kept`, then `fresh` is appended as station's turn
```

The server's commit uses `appendTail`. The view shades live text with it as well, so the two can never disagree.

### Data

```
State = { active: "B"|"C"|"D", turns: Turn[] }   turns[0] is the opening
Live  = { station: "B"|"C"|"D", tail: string, steering: string[] }
```

- **Tail:** the shown text after the floor, up to the main knob. Words are joined by single spaces. It never includes text generated past the knob.
- **Empty turns are kept.** Every commit appends exactly one turn, and a turn's text may be `""`. The floor is `floorOf(turns)` including any empty turns, and the document text is `joinTurns(turns)`.

### Routes

| Route                               | Body                                                                           | Responses                                                                                                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/events`                   | none                                                                           | SSE stream: `retry: 1000`, then `state`, then `live` if this turn already has one. After that: `state` after every commit, skip or reset; `live` after every accepted live post; `ping` every 15 s |
| `POST /api/live`                    | `Live`                                                                         | 204 · 400 · 409 not active · 413                                                                                                                                                                   |
| `POST /api/commit`                  | `{station, tail}`                                                              | 200 with the new `State` · 400 · 409 not active (already committed or skipped) · 413 · 500 save failed, nothing changed                                                                            |
| `POST /api/skip`, `POST /api/reset` | none, localhost only                                                           | 200 with `State` · 403                                                                                                                                                                             |
| `POST /ollama/v1/chat/completions`  | OpenAI chat request: `stream`, `temperature`, `reasoning_effort`, `max_tokens` | Ollama's stream, cancelled when the browser aborts · 502 if Ollama is down                                                                                                                         |

- Every SSE event is one `data:` line of JSON. `ping` carries empty data.
- Every error body is `{ "error": string }`. A 409 also includes `active`.

### Serial link (ESP32 → browser only)

```
line    = (endless SP step | trigger | capped SP ch SP pos | "#" text) CR LF
endless = "scrub" | "across" | "down"        step = nonzero signed int, positive = forward / next word / line below
trigger = "select" | "box" | "reroll" | "ok"
capped  = "value" | "strength"               ch = 1..8   pos = 0..1000
```

- **Boot sequence:** ROM boot messages (garbage to the browser), then an empty line, then `# spaceship-panel 1`, then every capped control as `value 1`, `strength 1`, `value 2`, `strength 2`…
- **Handshake:** the browser opens the port with `{ baudRate: 115200, bufferSize: 4096 }`, then resets the board: `setSignals({ dataTerminalReady: false, requestToSend: true })`, wait 100 ms, `setSignals({ requestToSend: false })`. It must never leave DTR on with RTS off, which boots the board into download mode. It drops every line until the marker arrives, or until 2 s have passed.
- **Parsing:** the browser splits on `\r?\n`, keeps only printable ASCII, matches tokens exactly, and drops anything that doesn't fit the grammar, including `#` lines.

### Timings and limits

| What                                             | Value                                                                            | Set by                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------- | ------------------------ |
| Endless and capped lines                         | at most one per 20 ms per control                                                | firmware                 |
| Endless handling                                 | steps summed per animation frame, one render per frame                           | client                   |
| Capped send rule                                 | a move of ≥20 from the last value sent, or exactly 0 or 1000 (always sent)       | firmware                 |
| Release                                          | strength ≤ 20 removes the channel's knob (firmware's exact 0 is the normal case) | client                   |
| Hold                                             | 1 s continuous                                                                   | firmware                 |
| Knob drop after input stops                      | 300 ms                                                                           | client                   |
| Live posts                                       | at most 5 per second, only on change, one in flight                              | client                   |
| SSE `ping` / client watchdog / EventSource retry | 15 s / reconnect after 45 s with no event / 1 s                                  | server / client / server |
| Model requests                                   | at most 4 at once; all aborted before a commit is posted                         | client                   |
| Model context                                    | the visible window plus at most the 6,000 words before it                        | client                   |
| Ollama                                           | `OLLAMA_NUM_PARALLEL=4`, `OLLAMA_KEEP_ALIVE=-1`, `OLLAMA_CONTEXT_LENGTH=16384`   | pA                       |

## Mismatches found and how they are resolved

| #   | Between           | Problem                                                                                                                                                        | Resolution                                                                                                                                 | Owner  |
| --- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| 1   | client ↔ server   | The server keeps empty turns. The client assumed they were dropped, so its floor and the server's would differ after any empty turn.                           | Keep empty turns. Both sides use `floorOf` and `joinTurns` from `turn-rules.ts`.                                                           | client |
| 2   | client ↔ server   | The server pings with `:` comments, which EventSource never shows to JavaScript. The client's 45 s watchdog wanted a `state` re-sent every 15 s.               | The server sends `event: ping` every 15 s, and the client's watchdog resets on any event.                                                  | both   |
| 3   | client ↔ server   | The commit split was written twice: the server's inline loop and the client's `keptWords` for shading.                                                         | One `splitTail` in `src/turn-rules.ts`, imported by both.                                                                                  | both   |
| 4   | client ↔ server   | The client could run 5–6 model streams at once. With SSE that fills Chromium's 6 connections per host, so a commit or live post would queue behind generation. | `ollama.ts` allows at most 4 requests at once (matching `OLLAMA_NUM_PARALLEL`), and `commitTurn` aborts all model requests before posting. | client |
| 5   | client ↔ Ollama   | Past roughly 12,000 words the whole manifesto exceeds the 16k context, and Ollama silently cuts the start of the prompt.                                       | Cap the hidden `head` at the last 6,000 words.                                                                                             | client |
| 6   | server ↔ Pis      | Two blockers the original plan missed: Vite refuses `pa.local`, and Ollama refuses an Origin it doesn't know.                                                  | `allowedHosts: ["pa.local"]`; the proxy sets the Origin header to `http://127.0.0.1:11434`; only `/ollama/v1/chat/completions` is proxied. | server |
| 7   | firmware ↔ client | The plan relied on the board resetting when the port opens, which isn't reliable.                                                                              | The browser resets the board itself, using the handshake above. Both plans had already chosen the same sequence.                           | client |
| 8   | firmware ↔ client | Bytes sent while the station sat on the view page might be held in the USB bridge, and a stale `ok` would commit the next turn the moment it starts.           | Drop all lines until `# spaceship-panel 1`, or for 2 s.                                                                                    | client |
| 9   | firmware ↔ client | The firmware asked for a 4096-byte receive buffer; the client used the default of 255.                                                                         | `open({ baudRate: 115200, bufferSize: 4096 })`.                                                                                            | client |
| 10  | firmware ↔ client | The firmware can send 50 lines per second per control. The client assumed about 30 and rendered on every scrub line.                                           | Sum the endless steps per animation frame.                                                                                                 | client |
| 11  | firmware ↔ plan   | The plan said ADC1 gives room for 4 channels. WROOM-32 boards wire out only 6 ADC1 pins.                                                                       | 3 channels on ADC1, a 4th on ADC2 pins 25 and 26 (fine with Wi-Fi off). Plan page corrected.                                               | plan   |
| 12  | server ↔ plan     | Under the agreed rule, the plan page's commit example credited "with a" to the wrong station.                                                                  | Example text changed so the split shown is the split the rule gives. Plan page corrected.                                                  | plan   |
| 13  | client ↔ server   | Both plans edit `vite.config.ts`.                                                                                                                              | The server plan owns it, including the `view.html` input.                                                                                  | server |

Already in agreement, no change needed:

- step signs and the order of the boot dump;
- that `#` lines are dropped;
- the URLs, the base path, and `appType: "mpa"`;
- status codes;
- page swaps: on a change of `active`, and a reload when `turns` differ from what was seeded, so a server restart with the same state leaves the editor alone;
- a double `ok` is harmless: `isCommitting` blocks it on the client, and the server answers 409;
- the view page never opens the serial port;
- `brltty` and ModemManager are purged on the Pis.

## Decisions for you

1. **Sliders left up by the last turn.** On page load the boot dump reports every slider. A channel whose strength is already past the gate would open a knob and pick from a freshly generated menu before the player has seen it. **Recommendation: channels arm at zero.** A channel opens a knob only after its strength has read 0 since the page loaded, or since its last knob pinned or was released. This adds one flag per channel in `steer()`. The plan text then becomes "after a knob pins, bring strength back to 0 to open a fresh knob".
2. **Empty turns lock the text before them.** If a station presses OK without writing anything, its empty turn becomes the last turn, so the next station can no longer rewrite the text before it. **Recommendation: keep this.** It follows directly from "rewrite the previous turn only". The alternative is to drop empty turns.

## Changes to each plan

- **server.md:** replace the `:` ping comments with `event: ping` (empty data) every 15 s. `applyCommit` uses `splitTail` from `src/turn-rules.ts` instead of its own loop. It owns `vite.config.ts`, including the `view.html` input.
- **client.md:**
  - Keep empty turns, using `floorOf` and `joinTurns` in `visibleWindow` and the view. Use `splitTail` instead of `keptWords`.
  - The watchdog resets on `ping` and on any other event.
  - Serial: open with `bufferSize: 4096`, then apply the marker gate.
  - Sum endless steps per frame.
  - Allow at most 4 model requests at once, and abort them before committing.
  - Cap `head` at 6,000 words.
  - If you accept decision 1, channels arm at zero.
- **firmware.md:** no change. It already sends the marker, always sends exact 0 and 1000, and prints `\r\n` line endings.

## Still unverified (step 1 of the build order)

- Raspberry Pi OS Chromium reads `/etc/chromium/policies/managed/`, `isSecureContext` is true, and `getPorts()` returns the board without a prompt.
- The `setSignals` reset on real CP2102 and CH340 boards: boot timing, and whether the bridges hold bytes while the port is closed.
- `pa.local` resolves in Chromium on the Pis.
- Ollama's Origin rule, and whether an aborted browser request stops generation (curl checks in `server.md` §10).
- How well gpt-oss:20b handles the prompts and fills the slots.
- Pi 4 render speed with a 5,000-word manifesto.
