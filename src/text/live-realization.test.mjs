import assert from "node:assert/strict"
import { test } from "node:test"
import { liveRealization } from "./live-realization.ts"

test("scores parse from the model's lines, asked sentences only, capped at 10", async () => {
  const reply = "1: 8\n[2] = 12\nsentence 3 is fine\n3: 5\n"
  globalThis.fetch = async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\ndata: [DONE]\n\n`)
  const request = { context: "", sentences: ["a", "b", "c"], asked: [0, 1], control: "stance: very radical" }
  const scores = []
  for await (const score of liveRealization(request, new AbortController().signal)) scores.push(score)
  assert.deepEqual(scores, [
    { index: 0, confidence: 0.8 },
    { index: 1, confidence: 1 },
  ])
})
