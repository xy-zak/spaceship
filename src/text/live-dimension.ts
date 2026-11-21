import { linesOf, streamCompletion } from "../llm/ollama.ts"
import { LENSES, type Station } from "../stations.ts"
import type { Dimension, DimensionContext, DimensionSource } from "./dimension.ts"

const MENU_SIZE = 5
const MAX_WORDS_PER_LABEL = 3
/** What the model writes in place of a slot: an axis with empty labels, filled from the manifesto. */
const CHOICE_SLOT = "<who the text names>"
const SCALE_SLOT = "<an idea the text holds> | <the idea it sets against it>"

/**
 * Independent axes of a manifesto passage, most consequential first, several of them from the debates in DAE's Institutional Plan.
 * Poles read after "very" or "somewhat", as the controls speak them.
 */
const CATALOG: Dimension[] = [
  { name: "tension", kind: "scale", low: "", high: "" },
  { name: "stance", kind: "scale", low: "pragmatic", high: "radical" },
  { name: "purpose", kind: "scale", low: "commercial", high: "social" },
  { name: "method", kind: "scale", low: "hands-on", high: "theoretical" },
  { name: "stakeholders", kind: "choice", options: [] },
  { name: "form", kind: "choice", options: ["principle", "provocation", "question", "example"] },
  { name: "tone", kind: "choice", options: ["urgent", "hopeful", "critical", "playful"] },
  { name: "perspective", kind: "scale", low: "singular", high: "pluralistic" },
  { name: "scope", kind: "scale", low: "individual", high: "collective" },
  { name: "horizon", kind: "scale", low: "present", high: "distant future" },
  { name: "technology", kind: "scale", low: "enthusiastic", high: "sceptical" },
  { name: "audience", kind: "choice", options: ["students", "educators", "institutions", "industry"] },
  { name: "register", kind: "scale", low: "plain", high: "academic" },
]

const SYSTEM_PROMPT = `
The user message has a manifesto on design education, cut off where the reader is, sometimes the reader's key phrases (keyword in brackets), sometimes the station's lens, and a list of axes. Each axis is one way the next passage could vary, written as "name: label | label".

Pick the axes that matter most for what the manifesto could say next at this point, as many as asked, most important first. With key phrases, favor the axes that act on them; with a lens, the axes that serve it. Output the picked lines unchanged, one per line, and nothing else.

The two exceptions have slots to fill from the manifesto, in at most 3 words per label:
- stakeholders: replace ${CHOICE_SLOT} with the 2 to 4 people or groups the manifesto names, in its words. Leave it out when it names fewer than 2.
- tension: replace ${SCALE_SLOT} with an idea the manifesto holds, in its words, and the idea it argues against, so a reader could steer toward either. Leave it out when the manifesto makes no claim yet.

EXAMPLE
User:
Manifesto: Design education must teach doubt before style. Students learn more from a failed prototype than from a client's brief, and tutors should
Key phrases:
- a failed [prototype]
Lens: how design is taught
Axes:
tension: ${SCALE_SLOT}
stance: pragmatic | radical
method: hands-on | theoretical
stakeholders: ${CHOICE_SLOT}
tone: urgent | hopeful | critical | playful
Pick 3.
Assistant:
method: hands-on | theoretical
tension: doubt | style
stakeholders: students | clients | tutors
`.trim()

/** One call offers the menu: the free catalog axes that matter most here, with the slots filled from the manifesto. Axes the model leaves out or garbles are filled in from the catalog. */
export function liveDimensionFor(station?: Station): DimensionSource {
  const lens = station ? LENSES[station] : ""
  return async function* (context, signal) {
    const takenNames = context.taken.map(({ name }) => name.toLowerCase())
    const free = CATALOG.filter(({ name }) => !takenNames.includes(name))
    const generic = free.filter(isGeneric)
    const size = Math.min(MENU_SIZE, generic.length)
    if (!size) return

    const offered: string[] = []
    const deltas = streamCompletion({
      system: SYSTEM_PROMPT,
      user: userMessageOf(context, lens, free, size),
      temperature: 0.3,
      maxTokens: 1500,
      signal,
    })
    for await (const line of linesOf(deltas)) {
      const dimension = dimensionOf(line, free, context.text)
      if (!dimension || offered.includes(dimension.name)) continue
      offered.push(dimension.name)
      yield dimension
      if (offered.length === size) return
    }
    yield* generic.filter(({ name }) => !offered.includes(name)).slice(0, size - offered.length)
  }
}

function userMessageOf({ text, leads }: DimensionContext, lens: string, free: Dimension[], size: number) {
  const keyPhrases = leads.length ? `Key phrases:\n${leads.map(({ before, keyword, after }) => `- ${before}[${keyword}]${after}`).join("\n")}\n` : ""
  return `Manifesto: ${text}\n${keyPhrases}${lens ? `Lens: ${lens}\n` : ""}Axes:\n${free.map(axisLine).join("\n")}\nPick ${size}.`
}

function axisLine(axis: Dimension) {
  if (axis.kind === "scale") return `${axis.name}: ${axis.low ? `${axis.low} | ${axis.high}` : SCALE_SLOT}`
  return `${axis.name}: ${axis.options.length ? axis.options.join(" | ") : CHOICE_SLOT}`
}

/** Reads a "name: label | label" line as one of `axes`: a generic axis keeps its catalog labels, a slot takes the model's if they fit its kind and come from `text` (every stakeholder, at least one pole of a tension); undefined otherwise. */
function dimensionOf(line: string, axes: Dimension[], text: string): Dimension | undefined {
  const [name, rest] = line.split(":", 2).map((part) => part.trim())
  const axis = axes.find((axis) => axis.name === name.toLowerCase())
  if (!axis || isGeneric(axis)) return axis
  const labels = (rest ?? "").split("|").map(plainLabel)
  // a slot filled with words the manifesto lacks was copied from the example
  const isInText = (label: string) => text.toLowerCase().includes(label.toLowerCase())
  if (!labels.every(isValidLabel) || !(axis.kind === "scale" ? labels.some(isInText) : labels.every(isInText))) return

  if (axis.kind === "scale") return labels.length === 2 ? { name: axis.name, kind: "scale", low: labels[0], high: labels[1] } : undefined
  return labels.length >= 2 && labels.length <= 4 ? { name: axis.name, kind: "choice", options: labels } : undefined
}

/** Drops a parenthesised aside, which the model sometimes adds to a label. */
function plainLabel(label: string) {
  return label
    .replace(/\(.*?\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

/** An axis with its own labels, as opposed to a slot the model fills. */
function isGeneric(axis: Dimension) {
  return axis.kind === "scale" ? axis.low !== "" : axis.options.length > 0
}

function isValidLabel(label: string) {
  return label !== "" && !label.includes("<") && label.split(" ").length <= MAX_WORDS_PER_LABEL
}
