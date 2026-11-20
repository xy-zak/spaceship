# Server plan (pA)

> Written by the server planning agent. Where this conflicts with [README.md](README.md), the README wins. In short: `event: ping` replaces the `:` comments, `applyCommit` uses `splitTail` from `src/turn-rules.ts`, and this plan owns `vite.config.ts`.

## 1. Summary

- **One process.** One Vite process runs everything. A small `server/turns.mjs` (about 150 lines, Node built-ins only) is mounted as a pre-middleware through both `configureServer` and `configurePreviewServer`. Vite's built-in proxy reaches Ollama.
- **URLs.** `/api/*` and `/ollama/v1/chat/completions` are at the origin root. Pages stay under `/spaceship/`.
- **State.** State is `{active, turns}`. Every change is written to disk first (temp file, fsync, rename), synchronously, and only then applied in memory. That makes each commit atomic and free of races.
- **Words.** A word is a run of non-whitespace (`/\S+/`), compared exactly, the same rule as `src/text/words.ts`. Committed text is stored with single spaces.
- **Proxy checked in the Vite 8.3.8 source:** it streams, and it cancels the upstream request when the browser aborts. Two blockers found there:
  - Vite's host check refuses `pa.local`.
  - Ollama refuses the browser's Origin header.

## 2. What exists and is reused or modified

**`vite.config.ts:5`**

- Keep `base: "/spaceship/"`, because the kiosk URLs already use it.
- Lines 7–17: add the `view` input. Keep the `extra/` glob; those pages are self-contained and import nothing from `src`.
- Add:

  ```ts
  appType: "mpa", // a missing view.html returns 404 instead of index.html, which would loop page swaps
  plugins: [turns({ file: resolve(import.meta.dirname, "data/manifesto.json") })],
  server: {
    allowedHosts: ["pa.local"], // Vite returns 403 for any hostname except localhost and IPs
    proxy: { "/ollama/v1/chat/completions": {
      target: "http://127.0.0.1:11434", changeOrigin: true,
      headers: { origin: "http://127.0.0.1:11434" }, // Ollama returns 403 for Origins it doesn't know
      rewrite: (path) => path.slice("/ollama".length) } },
  },
  preview: { host: true, strictPort: true }, // port 4173 is the default; proxy and allowedHosts carry over from server
  ```

**Other files**

- **`package.json`:** add `"test": "node --test"`. `preview` stays `vite preview`, since the config now sets host and port.
- **`tsconfig.json`:** no change. `allowImportingTsExtensions`, `verbatimModuleSyntax` and `erasableSyntaxOnly` are exactly what Node needs to load `src/stations.ts`.
- **`.gitignore`:** add `data/`.
- **`src/text/words.ts`:** this is the word rule the server must match. The knob and floor count words with `firstWords` and `countWords` (`text-stream.ts:122-139`).
- **`src/text/segments.ts:5`:** `wordSpans` uses Intl.Segmenter, which splits `style.` into a word and a separate `.`. It is for display only, never for counting the floor or the tail.
- **`src/text/live-completion.ts`:** continuations always start with a space, so new text never sticks to the last kept word.
- **`src/text/story-layout.ts`:** the editor already collapses whitespace, so storing single spaces on the server changes nothing on screen.
- **`README.md`:** add a short "Run on pA" section (section 4). The Pages demo link goes stale.

## 3. What to delete

- `.github/workflows/deploy.yml`. A static build has no `/api` or `/ollama`, so every push to master would publish a broken page.

## 4. What to add

```
server/turns.mjs        plugin, /api handler, state, SSE, saving, commit route
server/turns.test.mjs   node:test: the split table and HTTP round trips
src/stations.ts         shared configuration (see README)
src/turn-rules.ts       shared document rules: wordsOf, floorOf, joinTurns, splitTail (see README)
data/                   created at runtime, git-ignored: manifesto.json, archives
```

Following AGENTS.md: factories that close over state, no classes, general code first and pure functions last.

```js
export function turns({ file })        // Vite plugin: both hooks call server.middlewares.use(createTurnServer(file))
export function createTurnServer(file) // loads state when first called (never during `vite build`);
                                       // owns state, clients and live; returns (req, res, next)
export function applyCommit(state, station, tail) // pure; uses splitTail; returns the next State
// internal: loadState, saveState, readJson, send, broadcast, frame, change, fail, isLocal
```

**Persistence**

- `saveState` writes the temp file with `writeFileSync(tmp, json, { flush: true })`, then calls `renameSync(tmp, file)`.
- `change(next)` runs in order: save, set state, clear `live`, broadcast `state`. If the save throws, memory is untouched and the caller gets a 500.

**SSE** (README amendment: send a `ping` event, not a comment)

```js
res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" })
res.write(`retry: 1000\n\n${frame("state", state)}${live ? frame("live", live) : ""}`)
const ping = setInterval(() => res.write("event: ping\ndata:\n\n"), 15_000)
res.on("close", () => (clearInterval(ping), clients.delete(res))) // res, not req: req "close" fires once the body is read
// broadcast: res.writableLength > 1e6 ? res.destroy() : res.write(message)
```

The broadcast cap matters because a Pi whose network drops silently would otherwise pile up 5 live events per second until TCP gives up.

**Sharing `src/stations.ts` and `src/turn-rules.ts`**

- Vite's config loader bundles local imports, including `.ts` imported from `.mjs`.
- `node --test` uses Node 26's built-in type stripping (`process.features.typescript === "strip"`).
- Both files must stay erasable TypeScript: `.ts` extensions on relative imports, only `import type` between them, no DOM, no `import.meta.env`, no asset imports.

**Running on pA** (goes in the README)

```ini
# /etc/systemd/system/spaceship.service
[Unit]
After=network-online.target ollama.service
Wants=network-online.target ollama.service
[Service]
User=<user>
WorkingDirectory=<repo>
ExecStart=/usr/bin/npm run preview
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
```

- **Ollama:** run `sudo systemctl edit ollama` and add `Environment=` lines for `OLLAMA_NUM_PARALLEL=4`, `OLLAMA_KEEP_ALIVE=-1` and `OLLAMA_CONTEXT_LENGTH=16384`. Leave `OLLAMA_HOST` unset so it stays on 127.0.0.1. Run `ollama pull gpt-oss:20b`.
- **Deploy:** `git pull && npm ci && npm run build && sudo systemctl restart spaceship`. Don't set `NODE_ENV=production` before `npm ci`, because Vite is a devDependency. Use Node 26 on pA.
- **LAN name:** `hostnamectl set-hostname pa`, keep `avahi-daemon` enabled, and give pA a DHCP reservation. If Chromium can't resolve `.local`, add `<ip> pa.local` to each Pi's `/etc/hosts`.
- **Firewall:** `ufw allow from <lan-cidr> to any port 4173 proto tcp` and `ufw allow 5353/udp`. Never open 11434.

## 5. Libraries and tooling

None added. Everything uses `node:http` types, `node:fs`, `node:test`, and Vite's bundled proxy (http-proxy-3).

## 6. Architecture rules

1. The server is the only writer of the document. Stations send only tails, and the server never accepts a floor from a client.
2. From a validated body to the response, a change runs synchronously. The only `await` is reading the body, so two commits can't interleave.
3. Save, then change memory, then broadcast, then respond. On startup the disk is the truth; while running, memory is. Live text is never saved.
4. A word is `/\S+/`, compared with `===`, so case and punctuation count. Stored text is words joined by one space.
5. Ollama stays on loopback, and only one path is proxied to it.
6. `/api` and `/ollama` are at the origin root, and pages are under `/spaceship/`.

## 7. Interfaces

See the README for the full contract. This plan adds, marked **[EXT]** in its original form:

- 200 responses carry the new `State` for commit, skip and reset.
- A `live` event goes out on connect when this turn already has live text.
- `state` is broadcast after skip and reset, not only after commit.
- The Ollama proxy is narrowed to the single completions path (a deviation from `/ollama/*`).

**Validation** (the 400 checks run before the 409 check)

- JSON body of at most 256 K characters (413), and it must parse (400).
- `station` must be in `STATIONS` (400).
- `tail` must be a string of at most 50,000 characters (400).
- `steering` must be an array of at most 16 strings, each at most 200 characters (400).
- A non-active station gets 409 with `{error, active}`.
- Admin routes require the remote address `127.0.0.1`, `::1` or `::ffff:127.0.0.1`, otherwise 403.

**Files** in `data/`:

- `manifesto.json`: State as 2-space JSON in UTF-8.
- `manifesto.json.tmp`: the temp file used while saving.
- `manifesto-<stamp>.json`: a reset archive.
- `manifesto-corrupt-<stamp>.json`: a file that couldn't be read at startup is moved aside, never overwritten.

## 8. Assumptions about the client and the firmware

- Each station letter is used by exactly one Pi.
- One EventSource per page. The first `state` decides which page to show; after that the page swaps on a change of `active`, and reloads when `turns` differ from what it seeded. A server restart with an identical state doesn't disturb the editor.
- The tail stops at the main knob and never includes text generated past it.
- Live posts go out only when the text changes, at most 5 per second, never overlapping, and errors are ignored.
- On `ok` the client aborts its model streams, then posts the commit. It treats 409 as "already done, wait for `state`".
- At most 4 `/ollama` requests at once, and no Authorization header.
- The ESP32 never talks to the server. A double `ok` gets 409 the second time.

## 9. Edge cases and failures

**Commit split** (tested as a table)

- Opening only: the whole tail becomes the new turn; the opening is never touched.
- Empty or whitespace-only tail: the previous turn becomes `""` and the new turn is `""`.
- Tail is a prefix of the previous turn: the previous turn is trimmed and the new turn is `""`.
- Tail equals the previous turn: the previous turn is unchanged and the new turn is `""`.
- First word differs: the previous turn becomes `""` and the whole tail is the new turn.
- Previous turn already `""`: the whole tail is the new turn.
- `style.` and `style` count as different words.
- Newlines, NBSP and repeated spaces all collapse to single spaces.

**Races and failures**

- A double commit, or a stale live post arriving after a commit, gets 409.
- A skip during a commit runs after it.
- Crash before the rename: the old file survives and a retry succeeds. Crash after the rename: a retry gets 409, and the new state arrives on SSE reconnect.
- Server restart mid-turn: `active` survives, the last live text is lost until the next post, and EventSource reconnects within 1 s.
- Dev-mode restart after editing a config dependency: Vite destroys the old sockets, so the ping timers are cleared.
- A Pi reboots mid-turn: the views show the stale live text until the reloaded editor posts again. Uncommitted work is lost, as accepted.

## 10. Test and verification plan

`npm test` (node:test, a temp dir from `mkdtempSync`, a plain `http.createServer(createTurnServer(file))` on port 0):

- The split table above, and the B→C→D→B rotation.
- A new connection receives `state` first.
- Live and commit are relayed; a non-active station gets 409; bad JSON gets 400; an oversized body gets 413; an unknown station gets 400.
- A commit writes the file, and a second `createTurnServer` on the same file returns the same state (a simulated restart).
- Reset creates an archive; skip rotates the turn.

Manual checks, on both `npm run dev` and `npm run preview`:

- `curl -N … /ollama/v1/chat/completions -H 'Origin: http://pa.local:4173'` with `stream: true`: tokens arrive one by one.
- Ctrl-C mid-stream: `journalctl -u ollama` shows the request ending, and `nvidia-smi` drops.
- `/ollama/api/tags` returns 404.
- `Host: evil.example` gets 403; `pa.local` gets 200.
- `curl -N --compressed /api/events`: pings arrive, and there is no `Content-Encoding`.
- A commit in dev doesn't reload pages. If it does, add `server.watch.ignored: ["**/data/**"]`.
- Three tabs on one machine: use `localhost`, `127.0.0.1` and the LAN IP, so each gets its own 6-connection pool.

## 11. Open questions and risks

1. Storing single spaces drops paragraph breaks. That is fine while the manifesto stays flowing prose.
2. The model context limit is handled by the client's 6,000-word cap (README #5).
3. The plan assumes pA runs Linux with systemd.
4. Chromium resolving `.local` on the Pis is unverified.
5. There is no auth: any device on the LAN can post as the active station.
6. Not done: station presence tracking, a CI workflow to replace Pages, and warming up the model at boot (the first generation after a reboot waits for the model to load).
