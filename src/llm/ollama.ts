import { MODEL } from "../stations.ts"

const COMPLETIONS_URL = "/ollama/v1/chat/completions"
/** Matches OLLAMA_NUM_PARALLEL; more would also fill Chromium's 6 connections to pA, so a commit or live post would wait behind generation. */
const MAX_REQUESTS = 4
/** `VITE_MODEL=qwen3-vl:8b-instruct npm run dev` tries another installed model without changing the installation's. */
const model = import.meta.env?.VITE_MODEL || MODEL

export type CompletionRequest = {
  system: string
  user: string
  temperature: number
  maxTokens: number
  signal: AbortSignal
}

let running = 0
const waiting: (() => void)[] = []
let everything = new AbortController()

/** Streams the model's text through pA's proxy, waiting for a free slot first. Rejects if the proxy or Ollama fails. */
export async function* streamCompletion({ system, user, temperature, maxTokens, signal: callerSignal }: CompletionRequest) {
  // ended in `finally`, so a caller that stops reading early also stops the request and frees Ollama
  const ended = new AbortController()
  const signal = AbortSignal.any([callerSignal, everything.signal, ended.signal])
  await acquire(signal)
  try {
    const response = await fetch(COMPLETIONS_URL, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: true,
        reasoning_effort: "low",
        temperature,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    })

    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
    if (!response.body) throw new Error("no response body")

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ""

    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      buffer += value

      const events = buffer.split("\n")
      buffer = events.pop() ?? ""

      for (const line of events) {
        const data = line.startsWith("data:") ? line.slice(5).trim() : ""
        if (!data || data === "[DONE]") continue
        const content = JSON.parse(data).choices?.[0]?.delta?.content
        if (content) yield content as string
      }
    }
  } finally {
    ended.abort()
    running--
    waiting.shift()?.()
  }
}

/** Cancels every request, running or waiting, so a commit never queues behind generation. Later requests start normally. */
export function abortAll() {
  everything.abort(new DOMException("the turn is being passed", "AbortError"))
  everything = new AbortController()
}

export async function* linesOf(deltas: AsyncIterable<string>) {
  let buffer = ""
  for await (const delta of deltas) {
    const lines = (buffer + delta).split("\n")
    buffer = lines.pop()!
    yield* lines
  }
  yield buffer
}

async function acquire(signal: AbortSignal) {
  signal.throwIfAborted()
  if (running < MAX_REQUESTS) return void running++
  await new Promise<void>((resolve, reject) => {
    const start = () => {
      signal.removeEventListener("abort", cancel)
      running++
      resolve()
    }
    const cancel = () => {
      waiting.splice(waiting.indexOf(start), 1)
      reject(signal.reason)
    }
    waiting.push(start)
    signal.addEventListener("abort", cancel, { once: true })
  })
}
