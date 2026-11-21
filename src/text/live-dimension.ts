import { linesOf, streamCompletion } from "../llm/ollama.ts"
import type { Dimension, DimensionContext, DimensionSource } from "./dimension.ts"

const MENU_SIZE = 5
const MAX_WORDS_PER_LABEL = 3
/** Stands for the options of `focus` in the list of axes; the model replaces it with the story's characters. */
const CHARACTERS_SLOT = "<characters>"

/** Independent axes of a short passage, most consequential first. `focus` has no generic options: its options are the story's characters. */
const CATALOG: Dimension[] = [
  { name: "tension", kind: "scale", low: "relaxed", high: "strained" },
  { name: "resolution", kind: "scale", low: "open question", high: "answered" },
  { name: "pace", kind: "scale", low: "compressed", high: "expanded" },
  { name: "mode", kind: "choice", options: ["dialogue", "action", "description"] },
  { name: "focus", kind: "choice", options: [] },
  { name: "tone", kind: "choice", options: ["wry", "tender", "somber", "wondrous"] },
  { name: "distance", kind: "scale", low: "outside view", high: "inside mind" },
  { name: "fortune", kind: "scale", low: "worsens", high: "improves" },
  { name: "surprise", kind: "scale", low: "expected", high: "unexpected" },
]

const SYSTEM_PROMPT = `
The user message has the start of a story, cut off where the reader is, sometimes the reader's key phrases (keyword in brackets), and a list of axes. Each axis is one way the next 100 words could vary, written as "name: label | label".

Pick the axes that matter most for what could happen next at this point, as many as asked, most important first. With key phrases, favor the axes that act on them. Output the picked lines unchanged, one per line, and nothing else.

The one exception is focus, which is who the passage follows: replace <characters> with each character present in the story, by name or in at most 3 words. Leave focus out when the story has no character yet.

EXAMPLE
User:
Story: Mara had locked the kitchen an hour ago. Now a chair scraped across its tiles, and her brother was not answering his phone. She lay still and
Axes:
tension: relaxed | strained
pace: compressed | expanded
mode: dialogue | action | description
focus: <characters> | narrator
fortune: worsens | improves
Pick 3.
Assistant:
tension: relaxed | strained
focus: Mara | her brother | narrator
mode: dialogue | action | description
`.trim()

/** One call offers the menu: the free catalog axes that matter most here, with the story's characters as the options of `focus`. Axes the model leaves out or garbles are filled in from the catalog. */
export const liveDimension: DimensionSource = async function* (context, signal) {
  const takenNames = context.taken.map(({ name }) => name.toLowerCase())
  const free = CATALOG.filter(({ name }) => !takenNames.includes(name))
  const generic = free.filter((axis) => axis.kind === "scale" || axis.options.length)
  const size = Math.min(MENU_SIZE, generic.length)
  if (!size) return

  const offered: string[] = []
  const deltas = streamCompletion({
    system: SYSTEM_PROMPT,
    user: userMessageOf(context, free, size),
    temperature: 0.3,
    maxTokens: 1500,
    signal,
  })
  for await (const line of linesOf(deltas)) {
    const dimension = dimensionOf(line, free)
    if (!dimension || offered.includes(dimension.name)) continue
    offered.push(dimension.name)
    yield dimension
    if (offered.length === size) return
  }
  yield* generic.filter(({ name }) => !offered.includes(name)).slice(0, size - offered.length)
}

function userMessageOf({ text, leads }: DimensionContext, free: Dimension[], size: number) {
  const keyPhrases = leads.length ? `Key phrases:\n${leads.map(({ before, keyword, after }) => `- ${before}[${keyword}]${after}`).join("\n")}\n` : ""
  return `Story: ${text}\n${keyPhrases}Axes:\n${free.map(axisLine).join("\n")}\nPick ${size}.`
}

function axisLine(axis: Dimension) {
  if (axis.kind === "scale") return `${axis.name}: ${axis.low} | ${axis.high}`
  return `${axis.name}: ${axis.options.length ? axis.options.join(" | ") : `${CHARACTERS_SLOT} | narrator`}`
}

/** Reads a "name: label | label" line as one of `axes`, keeping that axis's kind; undefined when it is not one of them or its labels do not fit the kind. */
function dimensionOf(line: string, axes: Dimension[]): Dimension | undefined {
  const [name, rest] = line.split(":", 2).map((part) => part.trim())
  const axis = axes.find((axis) => axis.name === name.toLowerCase())
  const labels = (rest ?? "").split("|").map(plainLabel)
  if (!axis || !labels.every(isValidLabel)) return

  if (axis.kind === "scale") return labels.length === 2 ? { name: axis.name, kind: "scale", low: labels[0], high: labels[1] } : undefined
  return labels.length >= 2 && labels.length <= 4 ? { name: axis.name, kind: "choice", options: labels } : undefined
}

/** Drops a parenthesised aside, which the model sometimes adds to a character. */
function plainLabel(label: string) {
  return label
    .replace(/\(.*?\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function isValidLabel(label: string) {
  return label !== "" && label !== CHARACTERS_SLOT && label.split(" ").length <= MAX_WORDS_PER_LABEL
}
