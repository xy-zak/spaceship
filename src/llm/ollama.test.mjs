import assert from "node:assert/strict"
import { test } from "node:test"
import { abortAll, streamCompletion } from "./ollama.ts"

/** Each fake request streams one chunk, then stays open until it is aborted, like a long generation. */
const started = []
globalThis.fetch = async (_url, { signal, body }) => {
  started.push({ signal, body: JSON.parse(body) })
  const chunks = new ReadableStream({
    start(controller) {
      controller.enqueue(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`)
      signal.addEventListener("abort", () => controller.error(signal.reason))
    },
  })
  return new Response(chunks.pipeThrough(new TextEncoderStream()))
}
const request = () => streamCompletion({ system: "s", user: "u", temperature: 0, maxTokens: 10, signal: new AbortController().signal })
const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

test("at most 4 requests run; stopping early or abortAll frees them", async () => {
  const streams = Array.from({ length: 5 }, request)
  const firsts = streams.map((stream) => stream.next())
  await settle()
  assert.equal(started.length, 4)
  assert.equal(started[0].body.max_tokens, 10)
  assert.deepEqual(await firsts[0], { value: "hi", done: false })

  await streams[0].return()
  assert.ok(started[0].signal.aborted, "a reader that stops early ends its request")
  await settle()
  assert.equal(started.length, 5, "the waiting request takes the freed slot")

  await Promise.all(firsts)
  abortAll()
  for (const stream of streams.slice(1)) await assert.rejects(stream.next(), { name: "AbortError" })
  assert.ok(started.every(({ signal }) => signal.aborted))

  const after = request()
  assert.deepEqual(await after.next(), { value: "hi", done: false }, "requests after abortAll start normally")
  await after.return()
})
