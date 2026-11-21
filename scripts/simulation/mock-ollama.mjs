import { createServer } from "node:http"
import { setTimeout as sleep } from "node:timers/promises"

const PORT = Number(process.env.OLLAMA_PORT ?? 11434)
const TOKEN_MS = 60
const WORDS = (
  "teach doubt before style every brief should end with a question the client did not ask grades should reward " +
  "the courage to drop an idea studios belong to the people who use them make slowly argue in public"
).split(" ")
/** Ollama's default OLLAMA_ORIGINS: loopback only, so a Pi's Origin header must be rewritten by the proxy. */
const ALLOWED_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/

/** Stands in for Ollama on 127.0.0.1:$OLLAMA_PORT (11434 by default): streams random words as OpenAI chat chunks and refuses what Ollama would refuse. Resolves to undefined when the port is taken. */
export async function startMockOllama(log, expectedModel) {
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") return res.writeHead(404).end("404 page not found")
    if (req.headers.origin && !ALLOWED_ORIGIN.test(req.headers.origin)) return res.writeHead(403).end()
    const { model, max_tokens: maxTokens = 100 } = JSON.parse(await bodyOf(req))
    if (model !== expectedModel) return res.writeHead(404).end(JSON.stringify({ error: { message: `model "${model}" not found` } }))

    let isOpen = true
    res.on("close", () => (isOpen = false))
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    let sent = 0
    for (; sent < maxTokens && isOpen; sent++) {
      const content = ` ${WORDS[Math.floor(Math.random() * WORDS.length)]}`
      res.write(`data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`)
      await sleep(TOKEN_MS)
    }
    if (isOpen) res.end("data: [DONE]\n\n")
    log("ollama", isOpen ? `finished after ${sent} tokens` : `stopped after ${sent} tokens: the client aborted`)
  })
  return new Promise((resolve, reject) =>
    server.once("error", (error) => (error.code === "EADDRINUSE" ? resolve(undefined) : reject(error))).listen(PORT, "127.0.0.1", () => resolve(server)),
  )
}

async function bodyOf(req) {
  let body = ""
  for await (const chunk of req.setEncoding("utf8")) body += chunk
  return body
}
