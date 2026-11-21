import assert from "node:assert/strict"
import { test } from "node:test"
import { visibleWindow } from "./turns.ts"

const opening = { station: "opening", text: "Design education must" }
/** `count` ten-word sentences, so sentence starts fall on every tenth word. */
const sentences = (count) => Array.from({ length: count }, (_, i) => `Word${i} b c d e f g h i end.`).join(" ")
const wordCount = (text) => text.match(/\S+/g)?.length ?? 0

test("a short manifesto is shown whole, the last turn after the floor", () => {
  assert.deepEqual(visibleWindow([opening]), { head: "", text: "Design education must", floorWords: 3 })
  assert.deepEqual(visibleWindow([opening, { station: "B", text: "teach doubt" }]), {
    head: "",
    text: "Design education must teach doubt",
    floorWords: 3,
  })
  assert.deepEqual(visibleWindow([opening, { station: "B", text: "teach doubt" }, { station: "C", text: "" }]), {
    head: "",
    text: "Design education must teach doubt",
    floorWords: 5,
  })
})

test("a long manifesto shows the locked text from a sentence start", () => {
  const turns = [
    { station: "opening", text: sentences(30) },
    { station: "B", text: "last turn" },
  ]
  for (const minLockedWords of [200, 195]) {
    const { head, text, floorWords } = visibleWindow(turns, minLockedWords)
    assert.equal(floorWords, 200)
    assert.equal(wordCount(head), 100)
    assert.ok(text.startsWith("Word10 b c"))
    assert.ok(text.endsWith("end. last turn"))
  }
})

test("the head keeps only the last 6,000 words", () => {
  const { head, floorWords } = visibleWindow([{ station: "opening", text: sentences(650) }])
  assert.equal(floorWords, 200)
  assert.equal(wordCount(head), 6000)
  assert.ok(head.startsWith("Word30 b c"))
})
