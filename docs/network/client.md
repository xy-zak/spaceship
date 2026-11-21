# Client plan (browser on pB, pC, pD)

> Written by the client planning agent. Where this conflicts with [README.md](README.md), the README wins. In short:
>
> - Empty turns are kept: use `floorOf`, `joinTurns` and `splitTail` from `src/turn-rules.ts` instead of `keptWords`.
> - The watchdog resets on the server's `ping` event.
> - Serial: open with `bufferSize: 4096`, then drop lines until `# spaceship-panel 1`.
> - Endless steps are summed per frame.
> - At most 4 model requests at once, all aborted before a commit.
> - The hidden head is capped at 6,000 words.
> - Each steering channel is a slider for the angle and a rotary encoder for the strength. A knob opens at 10% on its channel's first touch, and each encoder step adds 4% (README decision 1).
> - Mouse and keyboard input stays beside the panel, so the mouse deletions in sections 2 and 3 are cancelled (README decision 3).

## 1. Summary

- **Editor.** `index.html` keeps its knob, buffer, steering fan and pinning engine. Every mouse path is replaced by one `handle(event)` dispatcher. Two sources feed it, serial and keyboard, both `(signal) => AsyncIterable<PanelEvent>`.
- **Text stream.** `text-stream` gets `seed({ head, text, floorWords })` with a hard floor. The hidden part of the manifesto (`head`) is added in front only in the completion prompt, so word indices still refer to the text on screen.
- **Networking.** A new `src/net/turns.ts` wraps EventSource, a throttled live poster, commit and the page swap; both pages use it. `view.html` is a light read-only page with per-author shading.
- **Cursor and knobs.** A new `src/text/word-cursor.ts` adds a word cursor drawn with the CSS Highlight API. Attention boxes get `toggleAt` and `focus`. Future knobs get `steer(channel, position, strength)`, which turns the panel values into the point the existing drag logic already accepts.
- **Size and load.** About 1,600 lines are deleted (pointer, rail, scoring, keys dialog), and no runtime dependencies are added. Pi load stays bounded by the visible window, a lower buffer (150 words), and drawing at most once per frame.

## 2. What exists, and how it is reused or changed

**`src/text/main.ts`**

- **Delete:**
  - lines 122–175: the mode toggle, sound toggle, `dblclick`, `onPressAndHold`, `makeDraggable` and `createPointer` wiring;
  - lines 336–442 and 471–509: `pointerTargets`, `clientRectsOf`, `zoneAt`, `caretBoxAt`/`caretBoxOf`, `selectionPreview`, `aimAt`, `tipRect`, `lastWordRect`, `refreshRail`, `lineSpansOf`, `soundWordsCrossed`, `showSoundToggle`;
  - the constants `HOLD_MS`, `DOUBLE_PRESS_MS`, `RAIL_GAP_PX`, `TRAY_PAD_PX` and `DRAG_SPEED_FULL`.
- **Startup:** lines 177–178 move into `start(state)`, which runs once on the first `state` where this station is active.
- **Keep:** `moveTo`, `restartRest` and `discardIfBehindRest`, the dwell and top-up logic, `prepareWords`, `caretAfterWords` and `metricsOf`.
- **Rename:** `pullToward` becomes `scrubBy`. `detachAllOrExpand` becomes `toggleAttention`, which toggles only the model's boxes; future knobs now belong to the panel.
- **`render`:** remove `connections`; add `cursor.update`, `attention.focus` and the floor highlight.
- **`report`:** also calls `postLive(tailOf(shownText), futureKnobs.controls().map(controlLine))`. It already runs after both renders and steering changes.
- **Buffer:** `BUFFER_WORDS` drops from 300 to 150.
- **Rendering:** `createTextStream(source, render)` becomes `createTextStream(source, scheduleRender)`. Stream chunks are combined into one draw per `requestAnimationFrame`, and panel events are summed per frame too (README #10).

**`src/text/text-stream.ts`**

- Remove `expand` from `TextSource` and the expand block in `generate`.
- `openingWords` becomes `floorWords`, and a `head` variable is added.
- Add `seed(next: { head: string; text: string; floorWords: number }): void`. It aborts any active generation, sets the state and calls `onChange`. Add a `get floorWords()` getter.
- `truncate` and `regenerate` both cut at `Math.max(count, floorWords)`. Remove the `count === 0` reset in `cutAfter`.
- `generate` calls `complete(head ? `${head} ${text}` : text, …)`. Chunks are still appended to `text`, so the head never appears on screen.

**`src/text/future-knobs.ts`**

- `spawn(point, pointerId)` becomes the internal `open(channel)`.
- Delete `makeDraggable`, `onDoubleClick`, the hover listeners and `setPointerCapture`. Without hover, `shown = tuned`, and the pinned-sentence highlight shows for the knob being steered.
- Add `steer`, which reuses the existing `drag()`, `updateCandidate()` (the gate at 96 px), `choose()` and `drop()`.
- Delete `clear` and `count`, whose only caller is gone.

**`src/text/attention-knobs.ts`**

- Delete the pointer listeners, `boxSelection`, `grab`/`moveGrabbed`/`dropGrabbed`, `boxAt`, `wordNear`, `nearestIndex`, `gap` and `pointOf`.
- Remove the options `isPastEnd`, `onHover` and `onPaint`, and the returned `spans`, `isDragging` and `isOverBox`.
- `hover()` becomes `focus(word)`. Add `toggleAt(word)`, which boxes the phrase around the word (`phraseAround`, section 4) or removes the box the word is in.
- Boxes from `expand` are recorded in a `WeakSet`. `collapse` and `isExpanded` look only at those, so a box the player made survives the `box` toggle.

**LLM sources**

- **`live-completion.ts`:**
  - Delete `expandToStoryStart` and the story openings, and rewrite the prompt and example for a manifesto.
  - One system prompt for steered and unsteered calls: the DAE Institutional Plan 2025-2028 as background the manifesto may take up or reject, the voice, the rules, one example, then the station's lens and themes (`LENS_THEMES` in `src/stations.ts`) and the word count last.
  - `liveSourceFor(station)` gives each editor the source for its lens.
  - Export `controlLine`.
  - The manifesto block stays **after** the key phrases and controls. Putting it first would let Ollama reuse its cached prefix when only the steering changes, but on qwen3-vl:8b it broke more sentences (1 of 3 joined) and ignored strong controls (1 of 3 followed).
- **`live-attention.ts`, `live-dimension.ts`:** new prompts; use `streamCompletion` from `llm/ollama.ts`; remove the API-key checks.
- **`live-dimension.ts` catalog:**
  - Slots are marked by empty labels (`options: []`, or `low: ""`).
  - `axisLine` writes `stakeholders: <who the text names>` and `tension: <an idea the text holds> | <the idea it sets against it>`.
  - A filled slot must use the manifesto's words (every stakeholder, at least one pole of a tension), so a copy of the example is dropped; generic axes keep their catalog labels whatever the model writes.
  - Adds `Lens: …` through `liveDimensionFor(station)`, so `DimensionContext` is unchanged.
- **`live-realization.ts`:**
  - Plain prompt, parsed with `^\[?(\d+)\]?\s*[:=]\s*(\d+)`.
  - Yields `{ index: n - 1, confidence: min(score, 10) / 10 }` for asked indices only, at `temperature: 0`.
- **Other:** `story/prompt.ts` is deleted; its prompt moved into `live-completion.ts`. In `sound/engine.ts`, delete `setSoundOn` and `isSoundOn`; with the autoplay flag the audio context starts already running. In `text-offsets.ts`, delete `textOffsetOf`.

**Unchanged:** `caret.ts`, `layout.ts`, `segments.ts`, `words.ts`, `story-layout.ts`, `realization-tracker.ts`, `status-line.ts`.

**`index.html`**

- **CSS to remove:**
  - `--rail-width` from the `#text` width;
  - `::selection`, `#rail`, `.knob { cursor: grab }`;
  - from `#pointer`: the `--near` ring, `[data-holding]` and `[data-dragging]`;
  - the cursor declarations;
  - the toggle, link and blink styles, the `#live-keys` style, and the custom pointer.
- **Markup:** delete `#rail`, `#cursor`, both toggles, the extra link and the `<dialog>`. Add `<b id="turn">` to the tray, and strip gesture hints from the `aria-label`s.
- **Add:** `::highlight(word-cursor)`, `::highlight(floor)`, and the no-mouse rules (`cursor: none`, `user-select: none`).

## 3. What to delete

- **Files:** `src/text/pointer.ts`, `drag.ts`, `hold.ts`, `left-rail.ts`, `connections.ts`, `keyword-relevance.ts`, `influence.ts`, `live-influence.ts`, `live-relevance.ts`, `simulated-influence.ts`, `simulated-relevance.ts`, `live-mode.ts`, `src/llm/decisions.ts`, `src/llm/cerebras.ts` (replaced), `src/story/openings.ts`.
- **Code regions:** as listed in section 2.
- **Will break, so delete:** `scripts/capture-clips.mjs` and `scripts/capture/hand.mjs`, which drive the app with a mouse.
- **Docs to update:** the LLM section of `AGENTS.md`, and the README's live-key text.

## 4. What to add

```
src/
  stations.ts            configuration (see README)
  turn-rules.ts          wordsOf, floorOf, joinTurns, splitTail (see README)
  theme.css              palette, font, no-mouse rules (second use: editor + view)
  llm/ollama.ts          streamCompletion (at most 4 at once), linesOf
  net/turns.ts           SSE events, live poster, commit, page swap, visible window
  input/serial.ts        PanelEvent, parseLine, serialEvents
  input/serial.test.mjs
  input/web-serial.d.ts  about 15 lines of ambient types for the parts of Web Serial used
  input/keyboard.ts      keyboardEvents (development stand-in)
  text/word-cursor.ts    word cursor state, highlight, pure step functions
  text/word-cursor.test.mjs
  view/main.ts           view page composition
view.html
```

```ts
// llm/ollama.ts  (POST /ollama/v1/chat/completions, no key, max_tokens)
export type CompletionRequest = { system: string; user: string; temperature: number; maxTokens: number; signal: AbortSignal }
export function streamCompletion(request: CompletionRequest): AsyncIterable<string>
export function linesOf(deltas: AsyncIterable<string>): AsyncIterable<string> // third copy today, so extracted

// input/serial.ts
export type PanelEvent =
  | { type: "scrub" | "across" | "down"; steps: number }
  | { type: "select" | "box" | "reroll" | "ok" }
  | { type: "value"; channel: number; position: number }
  | { type: "strength"; channel: number; steps: number }
export type PanelSource = (signal: AbortSignal) => AsyncIterable<PanelEvent>
export function parseLine(line: string): PanelEvent | undefined
export const serialEvents: PanelSource
// input/keyboard.ts
export const keyboardEvents: PanelSource // builds protocol lines and runs them through parseLine

// net/turns.ts
export type TurnState = { active: Station; turns: Turn[] }
export type Live = { station: Station; tail: string; steering: string[] }
export type TurnEvent = { type: "state"; state: TurnState } | { type: "live"; live: Live } | { type: "offline" }
export function stationOf(search: string): Station | undefined
export function turnEvents(signal: AbortSignal): AsyncIterable<TurnEvent>
export function createLivePoster(station: Station): (tail: string, steering: string[]) => void
export function commitTurn(station: Station, tail: string): Promise<"done" | "refused" | "failed">
export function swapTo(page: "editor" | "view"): void // location.replace(`${BASE_URL}${page === "view" ? "view.html" : ""}${location.search}`)
export function visibleWindow(turns: Turn[], minLockedWords = 200): { head: string; text: string; floorWords: number }

// text/word-cursor.ts
export function createWordCursor(textElement: HTMLElement): {
  update(content: string): void; across(steps: number): void; down(steps: number): void
  word(): number | undefined; rect(): DOMRect | undefined
}
export function stepAcross(index: number, steps: number, wordCount: number): number
export function stepDown(words: Span[], lineStarts: number[], index: number, steps: number, column: number): number

// future-knobs.ts / attention-knobs.ts additions
steer(channel: number, position: number, strength: number): void
toggleAt(word: number): void // boxes phraseAround(word), or removes the box that contains word
focus(word: number | undefined): void

// attention-knobs.ts, pure
/** The box a select makes: `index` is the keyword, stretched up to PHRASE_WORDS (3) words each side, never across . , ; : ! ? between words. */
export function phraseAround(words: Span[], text: string, index: number): AttentionBox
```

**Selected boxes are phrases.** One press of `select` makes the cursor's word the keyword and stretches the box to the phrase around it, the same `{ keyword, before, after }` shape as the model's boxes. The prompt then gets `end with a [question] the client did` instead of a bare `[question]`, with no extra input from the player. Pressing `select` anywhere inside a box removes it.

**Visible window**

- The locked text is `joinTurns(floorOf(turns))`. The last turn is the one that may be rewritten.
- The visible locked text starts at the beginning of the sentence (found with `sentenceSpans`) that holds word `locked - 200`. Before that is `head`, capped at the last 6,000 words.
- `text = visibleLocked + " " + lastTurn`, and `floorWords = countWords(visibleLocked)`.
- Attention, the dimension menu and realization see only the on-screen text. The completion prompt sees `head + text`.

**Tail:** `shownText.match(/\S+/g)?.slice(stream.floorWords).join(" ") ?? ""`. It stops at the knob, never includes generated text beyond it, and collapses whitespace.

**Word cursor**

- **State:** `index` counts words from `wordSpans`, the same index space attention uses, plus a goal `column`.
- **`update`:** clamps `index` to `words.length - 1`, so the cursor moves back when the knob cuts past it. The first non-empty update sets `index` to the last word.
- **`across`:** steps through reading order, so the end of a line continues onto the next. It sets `column = word.start - lineStart`.
- **`down`:** moves to the target line (clamped) and takes the word covering `column`. In a gap it takes the nearest word; past the end of the line, the last word.
- **Drawing:** `CSS.highlights.set("word-cursor", h)` with `h.priority = 1`, redrawn on every render, because replacing `textContent` collapses existing ranges.

**`steer(channel, v, s)`**

- `s <= 0.02` removes that channel's unpinned knob and returns.
- If the channel has no knob, or its knob has pinned, `open(channel)` creates one from the preloaded menu.
- Each call then:
  - starts a steer: unpark, `isDragging = true`, stop tracking, start the sound bed;
  - computes `swing = (2v - 1) * SWING_RADIANS` and `distance = minDistanceOf(knob) + s * STRENGTH_RANGE_PX`;
  - calls `drag(knob, center + polar(axis + swing, distance))`.
- With that mapping the dead zone is at s = 0.12, the gate (which chooses) at s = 0.48, and above the gate s maps directly to strength. No new constants are needed.
- After 300 ms without input, a knob with a dimension goes through `drop()` and starts tracking. A knob still choosing just stops being "dragged" and is kept, so a slow menu is not thrown away.

**Main dispatch** (ignored until the editor is seeded, and while committing)

| Event                | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scrub`              | `target = clamp(shown + steps, floorWords, countWords(stream.text))`, then `caretAfterWords`, `moveTo`, `discardIfBehindRest`, `sounds.word(…)`, `keepInView(knob)`                                                                                                                                                                                                                                                                                                                                 |
| `across` / `down`    | move the cursor, then `attention.focus(cursor.word())` and `keepInView(cursor.rect())`                                                                                                                                                                                                                                                                                                                                                                                                              |
| `select`             | `attention.toggleAt(cursor.word())`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `box`                | `toggleAttention()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `reroll`             | `regenerateFuture()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `value` / `strength` | `channels: Map<number, { value; strength }>`, with value unknown until first heard and strength 0 on every page load. A `value` line stores the position, and is a touch only if the position was already known (so the boot dump is not). A `strength` line is always a touch. A touch on a channel with no unpinned knob first restarts its strength at 0.1; a `strength` line then adds `0.04 × steps`, clamped to 0–1. After a touch, `futureKnobs.steer(ch, (value ?? 500) / 1000, strength)`. |
| `ok`                 | if `isCommitting`, return. Otherwise set `isCommitting`, show "passing…", abort all model requests, then `commitTurn`. On `done` or `refused`, `swapTo("view")`. On `failed`, clear `isCommitting` and show "not sent, hold OK again".                                                                                                                                                                                                                                                              |

**Editor startup**

1. Run `turnEvents`.
2. First `state`: if `active !== station`, swap to the view. Otherwise call `stream.seed(visibleWindow(turns))`, `moveTo(caretAfterWords(all))`, add the resize listener, and start both panel loops.
3. Later `state` events: if `active !== station`, swap to the view. If `turns` differ from the seeded turns (after a reset), `location.reload()`.
4. Without `?station`, the editor seeds the opening and skips networking, for development and simulated mode.

**View page**

- Builds `<span data-station>` runs per turn.
- Each `live` replaces the last turn. Using `splitTail(turns, tail)`, the `kept` words keep the previous author's shade and `fresh` goes in a `data-live` span (orange).
- Banner: "C is writing · ‹lens›", plus "next: you" when it applies, or "reconnecting…" while offline. A footer shows `steering.join(" · ")`.
- Scrolls to the bottom after each render. A `state` clears the live text. A `live` from a station that isn't `state.active` is ignored. A `state` with `active === station` triggers `swapTo("editor")`.
- The view does **not** open the serial port. Opening it would reset the ESP32 on every page swap, and input during the wait means nothing.

**Serial source**

- **No Web Serial:** if `navigator.serial` is missing, log "insecure origin?" and return.
- **Finding the port:** `getPorts()` filtered by `getInfo().usbVendorId` in {4292, 6790}. If there is none, wait for `navigator.serial`'s `connect` event.
- **Opening:** `open({ baudRate: 115200, bufferSize: 4096 })`, then reset the board: `setSignals({ dataTerminalReady: false, requestToSend: true })`, wait 100 ms, `setSignals({ requestToSend: false })`.
- **Marker gate:** drop all lines until `# spaceship-panel 1`, or until 2 s have passed.
- **Reading:** `port.readable.getReader()` with a streaming `TextDecoder`. Split on `\r?\n`, keep the partial last line buffered, and drop it if it grows past 256 characters. Strip characters outside `\x20-\x7e`, then `parseLine`; unknown lines are dropped.
- **Errors:** non-fatal read errors loop while `port.readable` exists. If the device is lost, close the port, wait 1 s, and go back to waiting for `connect`. On abort, cancel the reader.

**`parseLine`**

- Trim, then split on `/\s+/`; the token count must match exactly.
- Integers must match `^[+-]?\d+$`.
- Steps of 0 are dropped; other step counts are clamped to ±100.
- Channel must be 1–8, otherwise the line is dropped. Amounts are clamped to 0–1000.

**Keyboard stand-in**

| Key                      | Line           |
| ------------------------ | -------------- |
| `,` `.` (with Shift: ±5) | `scrub` ∓1     |
| ← →                      | `across` ∓1    |
| ↑ ↓                      | `down` ∓1      |
| Space                    | `select`       |
| `b`                      | `box`          |
| `r`                      | `reroll`       |
| `1`–`4`                  | pick a channel |
| `[` `]`                  | `value` ±50    |
| `-` `=`                  | `strength` ∓1  |
| Enter                    | `ok`           |

It calls `preventDefault` on handled keys and ignores key repeat for triggers.

## 5. Libraries and tooling

- **No dependencies added.** Web Serial types come from a small local `.d.ts` instead of `@types/w3c-web-serial`, because TypeScript's DOM library doesn't include Web Serial.
- **Tests:** run with `node --test`, as `.mjs` files that import the `.ts` modules through Node 26's type stripping. That keeps them out of `tsc`.
- **Optional:** point `scripts/cerebras-dev.mjs` at the proxy with an environment variable, to tune prompts for `gpt-oss:20b`.

## 6. Architecture rules

- Only the active station's editor calls the model or posts to the server. The view only reads.
- Each page's `main.ts` only wires modules together. Turns, input, the cursor and the stream own their own state.
- The editor never sends the floor, and never sends text past the knob.
- The panel holds the sliders' positions. Strength restarts at 0 on every page load, as do the on-screen toggles.
- Panel and keyboard stand-in input goes through `handle()`. The mouse keeps its own listeners (README decision 3).
- Long-running work is an `AsyncIterable` taking an `AbortSignal`: serial, keyboard, SSE and model calls.

## 7. Interfaces

See the README for the full contract. This plan's own additions:

- `steering` strings are one `controlLine` per steering knob, e.g. `stance: very radical (strong)`. Boxed phrases are not included.
- A strength of 2% or less counts as a release.
- The browser resets the board after opening the port.
- Live posts go out at most every 200 ms, only on change, with the latest winning and one in flight. The first post goes out right after seeding.

## 8. Assumptions about the server and the firmware

See the README; every assumption there has been matched against the server and firmware plans.

## 9. Edge cases

- **Boot garbage and partial lines:** they fail the exact-token parse, and no command is the suffix of another. The marker gate drops stale bytes.
- **Double `ok`, or `ok` during a commit:** blocked by `isCommitting`. A `state` arriving before the commit response still swaps the page.
- **Reload, skip or reset mid-turn:** the page re-seeds from server state (uncommitted work is lost, as accepted), or swaps to the view.
- **Page swap mid-generation:** navigation aborts all fetches.
- **Serial unplugged:** the source waits for `connect`, resets the board and gets the boot sync again.
- **SSE down:** editing continues and live posts fail silently. On reconnect, a `state` with different turns triggers a reload.
- **Scrubbing:** past the buffer it is clamped to the words generated so far. Below the floor it is clamped in two places, in main and in the stream.
- **Knob or cursor off screen:** `keepInView` scrolls by the overflow.

## 10. Test and verification

1. `node --test`:
   - `parseLine`: CRLF, garbage, out-of-range values, zero steps, extra tokens.
   - The word cursor: crossing a line end, keeping the column across short and long lines, clamping at the top and bottom, clamping after the text shrinks.
   - `phraseAround`: stopping at each punctuation mark, the start and end of the text, a one-word sentence.
2. `npm run build` passes, and a grep finds no `pointerdown`, `#rail` or `cerebras` left.
3. Laptop, simulated sources, keyboard:
   - scrub stops at the floor;
   - cursor plus select boxes words;
   - `box` keeps the player's boxes;
   - channels choose and pin;
   - three tabs pass turns.
4. With Ollama: the prompts on `gpt-oss:20b`, slot filling and realization scores.
5. ESP32 on the laptop (localhost counts as secure): the boot sync after the reset, and unplug/replug.
6. Pi:
   - `chrome://policy` shows both policies, `isSecureContext` is true, and `getPorts()` returns the board without a prompt;
   - with a 5,000-word seed, time `render` over remote debugging, and check `vcgencmd get_throttled`;
   - soak test: run `curl /api/skip` every 30 s on pA for hours.

**Kiosk setup** (Raspberry Pi OS. Trixie ships `chromium`, Bookworm `chromium-browser`, so check with `which`):

- Put the policy file at `/etc/chromium/policies/managed/spaceship.json`.
- Run `sudo raspi-config nonint do_boot_behaviour B4` (desktop autologin) and `do_blanking 1` (no screen blanking).
- The user must be in `dialout`. Purge `brltty` and ModemManager if installed; they grab CH340 and ttyUSB devices.
- `~/.config/labwc/autostart` runs `~/kiosk.sh &`:

```sh
URL="http://pa.local:4173/spaceship/?station=B&live=true"
until curl -sfo /dev/null "$URL"; do sleep 2; done
while true; do chromium --kiosk --noerrdialogs --no-first-run --hide-crash-restore-bubble \
  --password-store=basic --user-data-dir=/tmp/kiosk --autoplay-policy=no-user-gesture-required "$URL"; sleep 2; done
```

Use wired Ethernet for the Pis.

## 11. Open questions and risks

- **Leftover sliders at turn start:** settled by README decision 1. Strength is an encoder, so nothing is left up, and an angle left anywhere is harmless.
- **Font size:** 11px is likely too small at kiosk viewing distance.
- **View cost:** the view lays out the whole manifesto again on each live update. If the Pi struggles, show only a window there too.
- **Prompt order:** the manifesto before the steering helps prompt caching, but gpt-oss:20b may follow that order less well.
- **Boards without an auto-reset circuit:** they ignore the reset, so slider positions stay unknown until each slider moves.
