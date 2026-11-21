import assert from "node:assert/strict"
import { test } from "node:test"
import { liveDimensionFor } from "./live-dimension.ts"

test("the menu keeps catalog labels, and slots only with words from the manifesto", async () => {
  const reply = ["tension: doubt | style", "stakeholders: students | tutors", "stance: radical | pragmatic", "tension: portfolio | person", ""].join("\n")
  globalThis.fetch = async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\ndata: [DONE]\n\n`)
  const context = { text: "Design education must stop pretending that a portfolio is a substitute for students.", leads: [], taken: [] }
  const menu = []
  for await (const dimension of liveDimensionFor("B")(context, new AbortController().signal)) menu.push(dimension)
  assert.deepEqual(menu.slice(0, 2), [
    { name: "stance", kind: "scale", low: "pragmatic", high: "radical" },
    { name: "tension", kind: "scale", low: "portfolio", high: "person" },
  ])
  assert.equal(menu.length, 5)
  assert.ok(!menu.some(({ name }) => name === "stakeholders"))
})
