import assert from "node:assert/strict"
import { test } from "node:test"
import { liveSourceFor } from "./live-completion.ts"

const PLAN = [
  "CLAIM: Every studio must publish its budget to its students.\nBECAUSE: costs hide\nFOR INSTANCE: the material fund\nSO: students choose knowingly",
  "CLAIM: Tutors must be paid for the hours they spend on crits.\nBECAUSE: crits run on goodwill\nFOR INSTANCE: a Friday crit\nSO: crits get longer",
  "CLAIM: A brief must name who pays for its materials.\nBECAUSE: students pay\nFOR INSTANCE: a chair brief\nSO: the school pays",
].join("\n\n")

const TURNS = [
  { station: "opening", text: "Design education must" },
  { station: "B", text: "answer to students.", claim: "thesis: Design education must answer to its students." },
]

/** Answers every request with the next of `replies`, and keeps each request's messages. */
function replyWith(replies) {
  const requests = []
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body).messages)
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: replies.shift() } }] })}\n\ndata: [DONE]\n\n`)
  }
  return requests
}

async function continue_(source, steering = { leads: [], controls: [] }) {
  let text = ""
  for await (const chunk of source.complete("Design education must answer to students. Studios must", steering, 100, new AbortController().signal))
    text += chunk
  return text
}

test("each continuation writes a planned claim and its outline, planned once per steering", async () => {
  const requests = replyWith([PLAN, " publish the budget. Students see the costs.", " Students see more."])
  const source = liveSourceFor("C", () => TURNS)
  await continue_(source)
  await continue_(source)
  assert.equal(requests.length, 3)
  assert.match(requests[0][0].content, /^You plan the next passage/)
  const [system, user] = requests[1]
  assert.match(system.content, /- The manifesto argues: Design education must answer to its students\.\n- Its move is diagnose: what is wrong now/)
  assert.match(
    user.content,
    /^CLAIM TO MAKE\nEvery studio must publish its budget to its students\.\n\nOUTLINE\nbecause: costs hide\nfor instance: the material fund\nso: students choose knowingly\n\nMANIFESTO SO FAR\n/,
  )
  assert.equal(source.claim(), "diagnose: Every studio must publish its budget to its students.")
  assert.deepEqual(source.plan(), {
    move: "diagnose",
    candidate: {
      claim: "Every studio must publish its budget to its students.",
      points: [
        { label: "because", text: "costs hide" },
        { label: "for instance", text: "the material fund" },
        { label: "so", text: "students choose knowingly" },
      ],
    },
    isDone: true,
  })
})

test("reroll drops the claim, and the next continuation plans one that avoids every claim dropped", async () => {
  const requests = replyWith([PLAN, " One.", PLAN.replaceAll("must", "shall"), " Two.", PLAN.replaceAll("must", "will"), " Three."])
  const source = liveSourceFor("C", () => TURNS)
  await continue_(source)
  source.reroll()
  assert.equal(source.plan(), undefined)
  await continue_(source)
  assert.match(requests[2][1].content, /\n\nOFFERED BEFORE\n- Every studio must publish its budget to its students\.\n\n/)
  assert.match(requests[3][1].content, /^CLAIM TO MAKE\nEvery studio shall publish/)
  assert.equal(source.claim(), "diagnose: Every studio shall publish its budget to its students.")
  source.reroll()
  await continue_(source)
  assert.match(requests[4][1].content, /\n\nOFFERED BEFORE\n- Every studio must publish its budget to its students\.\n- Every studio shall publish/)
  assert.match(requests[5][1].content, /^CLAIM TO MAKE\nEvery studio will publish/)
})

test("a claim prepared ahead is the one the continuation with the same steering writes", async () => {
  const requests = replyWith([PLAN, " One."])
  const source = liveSourceFor("C", () => TURNS)
  source.prepare("Design education must answer to students.", { leads: [], controls: [] })
  assert.equal(source.plan().isDone, false)
  await continue_(source)
  assert.equal(requests.length, 2)
  assert.match(requests[1][1].content, /^CLAIM TO MAKE\nEvery studio must publish/)
})

test("a move control overrides the arc", async () => {
  const requests = replyWith([PLAN, " One."])
  const move = { dimension: { name: "move", kind: "choice", options: ["example", "objection", "consequence", "demand"] }, position: 0.3, strength: 0.5 }
  await continue_(
    liveSourceFor("C", () => TURNS),
    { leads: [], controls: [move] },
  )
  assert.match(requests[0][1].content, /\n\nMOVE\nobjection: the strongest objection/)
  assert.match(requests[1][0].content, /- Its move is objection:/)
  assert.match(requests[1][1].content, /^CONTROLS\nmove: objection \(options: example, objection, consequence, demand\) \(moderate\)\n\nCLAIM TO MAKE\n/)
})
