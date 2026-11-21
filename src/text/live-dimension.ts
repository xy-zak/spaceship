import { linesOf, streamCompletion } from "../llm/ollama.ts"
import { CATALOG, REQUEST, SYSTEM, userMessageOf } from "../prompts/menu.ts"
import { LENSES, type Station } from "../stations.ts"
import type { Dimension, DimensionSource } from "./dimension.ts"

const MENU_SIZE = 5
const MAX_WORDS_PER_LABEL = 3
/** Offered first whenever it is free, so how critical the manifesto is of the school stays the reader's choice. */
const ALWAYS_OFFERED = "toward DAE"

/** One call offers the menu: `ALWAYS_OFFERED`, then the free catalog axes that matter most here, with the slots filled from the manifesto. Axes the model leaves out or garbles are filled in from the catalog. */
export function liveDimensionFor(station?: Station): DimensionSource {
  const lens = station ? LENSES[station] : ""
  return async function* (context, signal) {
    const takenNames = context.taken.map(({ name }) => name.toLowerCase())
    const free = CATALOG.filter(({ name }) => !takenNames.includes(name.toLowerCase()))
    const generic = free.filter(isGeneric)
    const size = Math.min(MENU_SIZE, generic.length)
    if (!size) return

    const offered: string[] = []
    const pinned = generic.find(({ name }) => name === ALWAYS_OFFERED)
    if (pinned) {
      offered.push(pinned.name)
      yield pinned
      if (size === 1) return
    }
    const asked = free.filter((axis) => axis !== pinned)
    const deltas = streamCompletion({ ...REQUEST, system: SYSTEM, user: userMessageOf(context, lens, asked, size - offered.length), signal })
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

/** Reads a "name: label | label" line as one of `axes`: a generic axis keeps its catalog labels, a slot takes the model's if they fit its kind and come from `text` (every stakeholder, at least one pole of a tension); undefined otherwise. */
function dimensionOf(line: string, axes: Dimension[], text: string): Dimension | undefined {
  const [name, rest] = line.split(":", 2).map((part) => part.trim())
  const axis = axes.find((axis) => axis.name.toLowerCase() === name.toLowerCase())
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
