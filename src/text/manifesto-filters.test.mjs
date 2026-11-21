import assert from "node:assert/strict"
import { test } from "node:test"
import { filtered } from "./manifesto-filters.ts"

/** The model's reply to the next `continuationOf`, streamed a few characters at a time as the editor would receive it. */
let reply = ""

async function continuationOf(prefix) {
  async function* deltas() {
    yield* reply.match(/[\s\S]{1,3}/g)
  }
  let text = ""
  for await (const chunk of filtered(prefix, deltas())) text += chunk
  return text
}

test("a restart of the last sentences is dropped, but the full stop it adds is kept", async () => {
  reply = "The studio table is a courtroom. Every material must carry its debt — and its refusal.\n\nIn the lab, we test."
  const prefix = "Design education must teach doubt. The studio table is a courtroom. Every material must carry its debt — and its refusal"
  assert.equal(await continuationOf(prefix), ".\n\nIn the lab, we test.")
})

test("an echo of the last words is dropped", async () => {
  reply = "should end with a test a client can run within a week."
  assert.equal(await continuationOf("Every crit starts with a mistake. A brief should"), " end with a test a client can run within a week.")
})

test("new words that only start like the manifesto are kept", async () => {
  reply = "\n\nThe studio table is where the argument starts."
  assert.equal(await continuationOf("The studio table is a courtroom. We must"), " The studio table is where the argument starts.")
})

test("a sentence the manifesto already has is dropped wherever it comes", async () => {
  reply = " A crit is a rehearsal. The brief must name its waste. We must act."
  assert.equal(await continuationOf("We must teach doubt before style. A brief must name its waste."), " A crit is a rehearsal. We must act.")
})

test("contrasts become plain claims, unless the but opens a clause of its own", async () => {
  reply =
    " We must keep the tools open, not locked away. The studio, not the market, decides. Carry a receipt — not a diploma — a ledger." +
    " The studio must not be a showroom but a site of friction. The archive must not be curated but lived. AI must not replace the maker, but teach the maker." +
    " Choose a material not for its finish but for its memory. Not because it is new, but because it lasts. The studio must not be silent, but the lab must speak. Pin it beside its ledger, not as a footnote — but as its title. The student does not copy but learns. The map does not end at the door — but at the river. Teach collaborators, not masters—no studio waits. Ask the soil — not the market, not the grant. A show must not be a showcase but a question, and the tools must be taught. A critique is not a verdict; it is a rehearsal. A crit isn’t a review, it’s a game. A studio must not just house makers but also stewards of what’s not made."
  assert.equal(
    await continuationOf("Design education must change. It must change now. It must change here."),
    " We must keep the tools open. The studio decides. Carry a receipt — a ledger." +
      "\n\nThe studio must be a site of friction. The archive must be lived. AI must teach the maker. Choose a material for its memory. Because it lasts. The studio must not be silent, but the lab must speak.\n\nPin it beside its ledger, as its title. The student learns. The map does end at the river. Teach collaborators — no studio waits. Ask the soil. A show must be a question, and the tools must be taught.\n\nA critique is a rehearsal. A crit is a game. A studio must house makers and stewards of what’s not made.",
  )
})

test("words that only start like a contrast pass through", async () => {
  reply = " Nothing is fixed, nothing is final, notably the brief."
  assert.equal(await continuationOf("Design education must change."), " Nothing is fixed, nothing is final, notably the brief.")
})

test("a copy of the prompt's example is dropped", async () => {
  reply =
    " Every studio must open its doors. Count the waits at every stop as well as the rides, and publish what each costs in minutes and fares. We must act."
  assert.equal(await continuationOf("Design education must change."), " Every studio must open its doors. We must act.")
})

test("a restart of the unfinished last sentence keeps only the words that finish it", async () => {
  reply = " The prototype must be probed, the frame must carry the weight of those erased, the labor that was stolen. We act."
  const prefix = "Design education must change. The prototype must be probed, the frame must carry the weight of those erased, the labor"
  assert.equal(await continuationOf(prefix), " that was stolen. We act.")
})

test("a paragraph breaks after three to six sentences, counting the manifesto's last one", async () => {
  reply = "\n\nOne must go. Two must go.\n\nThree must go. Four must go.\n\nFive must go. Six must go. Seven must go. Eight must go. Nine must go. Ten must go."
  assert.equal(
    await continuationOf("Design education must change."),
    " One must go. Two must go.\n\nThree must go. Four must go. Five must go. Six must go. Seven must go. Eight must go.\n\nNine must go. Ten must go.",
  )
})

test("a copy that finishes the manifesto's open sentence stays, and dashes split words", async () => {
  reply = " teach the scale of climate—because the crisis is a condition. We act now."
  assert.equal(
    await continuationOf("We must teach the scale of climate — because the crisis is a condition. We must"),
    " teach the scale of climate—because the crisis is a condition. We act now.",
  )
  reply = " Studios must open. We must teach the scale of climate—because the crisis is a condition. We act now."
  assert.equal(await continuationOf("We must teach the scale of climate — because the crisis is a condition."), " Studios must open. We act now.")
})

test("a new sentence after the manifesto's unfinished one gets a full stop, and a short echo after a dropped restart goes", async () => {
  reply = " We must act now."
  assert.equal(await continuationOf("Benches bolted to sidewalks and manifestos"), ". We must act now.")
  reply = " Who is this world built for? And the answer must come from the soil."
  assert.equal(await continuationOf("Ask a question. Who is this world built for? And the"), " answer must come from the soil.")
})

test("after a finished sentence, its last words may open the next one", async () => {
  reply = " The studio must become a site of reckoning."
  assert.equal(await continuationOf("Design its ethics into the fabric of the studio."), " The studio must become a site of reckoning.")
})
