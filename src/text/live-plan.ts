import { linesOf, streamCompletion } from "../llm/ollama.ts"
import { BANK, type Entry } from "../prompts/bank.ts"
import { ARC, KINDS_FOR, OUTLINE, REQUEST, SOURCES, systemOf, userOf, type Candidate, type Side } from "../prompts/plan.ts"
import type { Station } from "../stations.ts"
import { gradeIndexOf, strengthLevelOf, valueOf, type Control } from "./dimension.ts"
import { plainClaims } from "./manifesto-filters.ts"

const CLAIM_WORDS = { min: 5, max: 45 }
/** With its move in front, a claim stays inside the 400 characters the server takes. */
const MAX_CLAIM_CHARS = 300
/** Claims that open with the same words make the same point, as a reworded copy keeps its subject and verb. */
const SAME_OPENING_WORDS = 6
const LABELS = Object.keys(OUTLINE)
const LABEL = new RegExp(`^(source|claim|${LABELS.join("|")})\\s*[*_]*\\s*:\\s*`, "i")

/** The move a `move` control picks, or else the arc's: the thesis first, then `ARC` in turn. `claims` counts the argument's claims so far. */
export function moveOf(claims: number, controls: Control[]) {
  const chosen = controls.find(({ dimension }) => dimension.name === "move")
  if (chosen) return valueOf(chosen)
  return claims ? ARC[(claims - 1) % ARC.length] : "thesis"
}

/**
 * The bank entries a plan argues from, `SOURCES` of them on as many themes: the lens's own, favouring the move's kinds and the Institutional Plan, otherwise at random.
 * The knob on DAE picks the side of each the planner sees, supportive or critical; without it, midway or slight, both.
 */
export function sourcesFor(station: Station | undefined, move: string, controls: Control[], random = Math.random) {
  const kinds = KINDS_FOR[move] ?? []
  const ranked = BANK.filter(({ lenses }) => !station || lenses.includes(station))
    .map((entry) => ({ entry, score: (kinds.includes(entry.kind) ? 2 : 0) + (entry.source === "plan" ? 1 : 0) + 2 * random() }))
    .sort((a, b) => b.score - a.score)
  const sources: Entry[] = []
  for (const { entry } of ranked) {
    if (sources.some(({ theme }) => theme === entry.theme)) continue
    sources.push(entry)
    if (sources.length === SOURCES) break
  }
  const knob = controls.find(({ dimension }) => dimension.name === "toward DAE")
  const grade = knob && strengthLevelOf(knob.strength) !== "slight" ? gradeIndexOf(knob.position) : 2
  const sides: Side[] = grade < 2 ? ["for"] : grade > 2 ? ["against"] : ["for", "against"]
  return { sources, sides }
}

/**
 * Plans one claim for the passage's `move`, with its outline. `argument` is the claims so far as "move: claim", the thesis first.
 * A claim that repeats one of them or one `offered` before is dropped; if none is left, asks once more, then gives up with undefined. Rejects if a request fails or `signal` aborts.
 * `controls` pick the side of the bank's sources it argues, as in `sourcesFor`.
 */
export async function planPassage({
  station,
  argument,
  offered,
  prefix,
  steering,
  controls,
  move,
  signal,
}: {
  station?: Station
  argument: string[]
  offered: string[]
  prefix: string
  steering: string
  controls: Control[]
  move: string
  signal: AbortSignal
}) {
  const { sources, sides } = sourcesFor(station, move, controls)
  const system = systemOf(station, sources, sides)
  const taken = [...argument.map((claim) => claim.replace(/^\w+: /, "")), ...offered].map(openingOf)
  let user = userOf({ argument, offered, prefix, steering, move })
  for (let attempt = 0; attempt < 2; attempt++) {
    for await (const candidate of candidatesOf(linesOf(streamCompletion({ ...REQUEST, system, user, signal }))))
      if (!taken.includes(openingOf(candidate.claim))) return candidate
    user += "\n\nThat claim was missing or repeated the argument. Write a new one."
  }
}

/**
 * Reads candidates from the reply's lines: a claim line starts one, and each outline line adds its point; source lines only steer the planner. Labels may be bolded or left out, and then a line is the next part the candidate lacks.
 * A claim without points is dropped once another claim follows, as a preamble reads like one; at the end of the reply it is kept.
 */
async function* candidatesOf(lines: AsyncIterable<string>) {
  let candidate: Candidate | undefined
  for await (const line of lines) {
    const { label, text } = labelled(line)
    if (!text || text.endsWith(":") || label === "source") continue
    const part = label ?? (candidate && candidate.points.length < LABELS.length ? LABELS[candidate.points.length] : "claim")
    if (part === "claim") {
      if (candidate?.points.length) yield candidate
      candidate = isClaim(text) ? { claim: text, points: [] } : undefined
    } else if (candidate && !candidate.points.some((point) => point.label === part)) candidate.points.push({ label: part, text })
    if (candidate?.points.length === LABELS.length) {
      yield candidate
      candidate = undefined
    }
  }
  if (candidate) yield candidate
}

/** A line's label, if it has one, and its text, without list marks, emphasis, quotes or the contrasts the writer's text loses too, as the writer would copy them. */
function labelled(line: string) {
  const bare = line.replace(/^\s*(?:\d+[.)]\s+|[-•>]\s+)?[*_#\s]*/, "")
  const match = LABEL.exec(bare)
  const text = plainClaims((match ? bare.slice(match[0].length) : bare).replace(/^[\s*_"“]+|[\s*_"”]+$/g, ""))
  return { label: match?.[1].toLowerCase(), text }
}

function isClaim(text: string) {
  const words = text.split(/\s+/).length
  return words >= CLAIM_WORDS.min && words <= CLAIM_WORDS.max && text.length <= MAX_CLAIM_CHARS
}

function openingOf(claim: string) {
  return (claim.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, SAME_OPENING_WORDS).join(" ")
}
