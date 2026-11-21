import assert from "node:assert/strict"
import { test } from "node:test"
import { planPassage, sourcesFor } from "./live-plan.ts"

/** Answers every request with the next of `replies` and keeps each request's body. */
function replyWith(replies, requests = []) {
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body))
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: replies.shift() } }] })}\n\ndata: [DONE]\n\n`)
  }
  return requests
}

const plan = (argument, offered = []) =>
  planPassage({
    station: "B",
    argument,
    offered,
    prefix: "Design education must",
    steering: "",
    controls: [],
    move: "define",
    signal: new AbortController().signal,
  })

test("the claim is read with its outline, whatever its labels look like, and sent with the thesis, the argument and the lens's sources", async () => {
  const reply = [
    "Here is the claim:",
    "**Source:** 2",
    "1. **CLAIM:** Every studio must publish its budget to the students who pay for it.",
    "costs hide",
    "**FOR INSTANCE:** the material fund",
    "So: students choose studios knowingly",
    "",
    "CLAIM: A second claim that nobody asked for at all.",
  ].join("\n")
  const requests = replyWith([reply])
  assert.deepEqual(await plan(["thesis: Design education must answer to its students.", "diagnose: Studios hide their costs."]), {
    claim: "Every studio must publish its budget to the students who pay for it.",
    points: [
      { label: "because", text: "costs hide" },
      { label: "for instance", text: "the material fund" },
      { label: "so", text: "students choose studios knowingly" },
    ],
  })
  const [{ messages }] = requests
  assert.match(
    messages[0].content,
    /YOUR LENS\nhow design is taught\n\nSOURCES FROM DAE'S PLAN AND REPORTS\n1\. (plan|reports?[\d -]+): .+\n  case for: .+\n  case against: /,
  )
  assert.match(messages[1].content, /^THESIS\nDesign education must answer to its students\.\n\nARGUMENT SO FAR\n1\. diagnose: Studios hide their costs\./)
  assert.match(messages[1].content, /\n\nMOVE\ndefine: what a key word/)
})

test("claims that repeat the argument or an offered claim are dropped; with none left, the planner is asked once more", async () => {
  const argument = ["thesis: Design education must answer to its students."]
  const requests = replyWith([
    "CLAIM: Design education must answer to its students, always.\nCLAIM: Tutors must be paid for every crit they run.",
    "CLAIM: Pay tutors.",
  ])
  assert.equal(await plan(argument, ["Tutors must be paid for every crit, whatever it costs."]), undefined)
  assert.equal(requests.length, 2)
  assert.match(requests[0].messages[1].content, /\n\nOFFERED BEFORE\n- Tutors must be paid/)
  assert.match(requests[1].messages[1].content, /repeated the argument\. Write a new one\.$/)
  replyWith([
    "Tutors must be paid for the hours they spend on crits.\nunpaid crits run short\nCLAIM: Tutors must be paid for the hours of every crit.\nBECAUSE: crits are work",
  ])
  assert.deepEqual(await plan(argument), {
    claim: "Tutors must be paid for the hours they spend on crits.",
    points: [{ label: "because", text: "unpaid crits run short" }],
  })
})

test("claims lose their contrasts, as the writer's text does", async () => {
  replyWith(["CLAIM: Design education must teach students to design for systems, not just objects.\nBECAUSE: a crit is not a verdict; it is a rehearsal"])
  assert.deepEqual(await plan([]), {
    claim: "Design education must teach students to design for systems.",
    points: [{ label: "because", text: "a crit is a rehearsal" }],
  })
})

test("a plan argues from the lens's sources, one per theme, the move's kinds and the plan's first, on the side the knob on DAE picks", () => {
  const knob = (position, strength = 1) => ({ dimension: { name: "toward DAE", kind: "scale", low: "supportive", high: "critical" }, position, strength })
  const { sources, sides } = sourcesFor("B", "example", [knob(0.9)], () => 0)
  assert.equal(sources.length, 6)
  assert.equal(new Set(sources.map(({ theme }) => theme)).size, 6)
  assert.ok(sources.every(({ lenses, kind }) => lenses.includes("B") && ["example", "fact"].includes(kind)))
  assert.equal(sources[0].source, "plan")
  assert.deepEqual(sides, ["against"])
  assert.deepEqual(sourcesFor("B", "example", [knob(0.1)]).sides, ["for"])
  assert.deepEqual(sourcesFor("B", "example", [knob(0.9, 0.1)]).sides, ["for", "against"])
  assert.deepEqual(sourcesFor("B", "example", []).sides, ["for", "against"])
})
