import assert from "node:assert/strict"
import { test } from "node:test"
import { createTextStream } from "./text-stream.ts"

const steering = { leads: [], controls: [] }

test("a generation stops once it has the words it asked for, ending the source's stream", async () => {
  const asked = []
  let isClosed = false
  const source = {
    async *complete(_prefix, _steering, words) {
      asked.push(words)
      try {
        for (const chunk of [" one two thr", "ee four", " five six"]) yield chunk
      } finally {
        isClosed = true
      }
    },
  }
  const stream = createTextStream(source, () => {})
  stream.seed({ head: "", text: "Design education must", floorWords: 3 })
  assert.equal(await stream.generate("buffer low", steering, 3), "done")
  assert.deepEqual(asked, [3])
  assert.equal(stream.text, "Design education must one two three")
  assert.ok(isClosed)

  assert.equal(await stream.generate("buffer low", steering, 10), "done")
  assert.equal(stream.text, "Design education must one two three one two three four five six")
})
