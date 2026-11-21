import { LENSES, type Station } from "../stations.ts"
import type { Entry, Kind } from "./bank.ts"
import { bulleted } from "./format.ts"

/** One claim the next passage could make, with the points that argue it, in `OUTLINE`'s order; a point the planner left out is missing. */
export type Candidate = { claim: string; points: { label: string; text: string }[] }

/** Which of a bank entry's cases the planner sees: the case for the school's point, against it, or both. */
export type Side = "for" | "against"

/** Each move's job in the argument. */
export const MOVES: Record<string, string> = {
  thesis: 'the one claim the whole manifesto will argue, a sentence that starts "Design education must"',
  diagnose: "what is wrong now, that the thesis answers",
  define: "what a key word of the argument must mean in a design school",
  example: "a concrete case of the last claim: a studio, a crit, a brief, a budget or a building where it plays out",
  objection: "the strongest objection to the last claim, and the answer to it",
  consequence: "what follows for students, tutors or the school if the last claim holds",
  demand: "what someone must do because of the argument: who, what, and by when",
  call: "a call to the reader to act on the argument so far",
}
/** The moves after the thesis, in turn; after the last the arc starts again, so a long manifesto keeps restating its case in new sections. A `move` control overrides it. */
export const ARC = ["diagnose", "define", "example", "objection", "consequence", "demand", "call"]
/** The points that argue a claim, and what each holds; the writer makes them in this order. */
export const OUTLINE: Record<string, string> = {
  because: "the reason the claim holds",
  "for instance": "one concrete case, from its source when the source gives one: a studio, a crit, a brief, a budget or a building",
  so: "what follows for students, tutors or the school",
}
/** The kinds of bank entry each move argues from best; a plan's sources favour them. */
export const KINDS_FOR: Record<string, Kind[]> = {
  thesis: ["position", "tension"],
  diagnose: ["tension", "trend", "fact"],
  define: ["position"],
  example: ["example", "fact"],
  objection: ["tension", "trend"],
  consequence: ["fact", "trend", "position"],
  demand: ["position", "tension"],
  call: ["position", "example"],
}
/** Bank entries per plan, each on another theme: enough to choose from, few enough for a 4k context. */
export const SOURCES = 6
/** Claims offered per plan; reroll steps through them, then asks for new ones. */
export const CANDIDATES = 3
/** Thinking models spend these tokens on reasoning too. */
export const REQUEST = { temperature: 0.7, maxTokens: 1500 }
/** Enough of the manifesto's end to see where its last sentence stops. */
const LAST_WORDS = 80

const RULES = [
  "Each claim does the move's job, serves the thesis, and follows from the argument's last claim.",
  "The claims differ: each takes another side, subject or stakeholder, so a reader has a real choice between them.",
  "Each says something the argument does not say yet: never repeat or reword an earlier claim, or one offered before.",
  'Each is concrete and arguable: it says who must do what, naming a studio, a tutor, a student, a brief, a crit, a budget, a building or a partner, and a reader could disagree with it. No imagery and no "not".',
  "Ground each in a different one of the sources below, arguing from the case given with it. Their facts and figures are true: use them, invent none, and say them in your own words.",
  "Key phrases, when given, are what the claims are about. Controls, when given, set their stance and focus; a strong control decides them.",
]

/** The parser in `text/live-plan.ts` reads these labels. Naming its source first makes a small model argue from it. */
const FORMAT = [
  "SOURCE: the number of the source below that the claim argues from",
  "CLAIM: one plain sentence of at most 25 words",
  ...Object.entries(OUTLINE).map(([label, holds]) => `${label.toUpperCase()}: ${holds}, in at most 12 words`),
].join("\n")

const SYSTEM = `You plan the next passage of a manifesto on design education. Writers take turns on it, each from their own lens, and each passage makes one claim that moves a single argument on. You are told the passage's move. Offer ${CANDIDATES} claims for it, each with its outline, in this form, with a blank line between them and nothing else:
${FORMAT}

${bulleted(RULES)}`

/** `sources` are the bank entries the plan argues from, each shown with its case on each of `sides`. */
export function systemOf(station: Station | undefined, sources: Entry[], sides: Side[]) {
  const lens = station ? `\n\nYOUR LENS\n${LENSES[station] || "design education as a whole"}` : ""
  return `${SYSTEM}${lens}\n\nSOURCES FROM DAE'S PLAN AND REPORTS\n${sources.map((entry, i) => sourceOf(entry, i + 1, sides)).join("\n")}`
}

/** `argument` is the claims so far as "move: claim", the thesis first; `offered` the claims a reroll passed over; `steering` the key phrases and controls as the writer gets them. */
export function userOf({
  argument,
  offered,
  prefix,
  steering,
  move,
}: {
  argument: string[]
  offered: string[]
  prefix: string
  steering: string
  move: string
}) {
  const [thesis, ...claims] = argument
  const last = prefix.match(/\S+/g)?.slice(-LAST_WORDS).join(" ") ?? ""
  return [
    `THESIS\n${thesis ? thesis.replace(/^thesis: /, "") : "none yet"}`,
    claims.length ? `ARGUMENT SO FAR\n${claims.map((claim, i) => `${i + 1}. ${claim}`).join("\n")}` : "",
    offered.length ? `OFFERED BEFORE\n${bulleted(offered)}` : "",
    steering,
    `THE MANIFESTO ENDS\n…${last}`,
    `MOVE\n${move}: ${MOVES[move]}`,
  ]
    .filter(Boolean)
    .join("\n\n")
}

function sourceOf(entry: Entry, number: number, sides: Side[]) {
  return [`${number}. ${entry.source}: ${entry.point}`, ...sides.map((side) => `  case ${side}: ${entry[side]}`)].join("\n")
}
