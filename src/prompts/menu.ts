import type { Dimension, DimensionContext } from "../text/dimension.ts"

export const REQUEST = { temperature: 0.3, maxTokens: 1500 }
/** What the model writes in place of a slot: an axis with empty labels, filled from the manifesto. */
const CHOICE_SLOT = "<who the text names>"
const SCALE_SLOT = "<an idea the text holds> | <the idea it sets against it>"

/**
 * Independent axes of a manifesto passage, most consequential first, several of them from the debates in DAE's Institutional Plan.
 * Poles read after "very" or "somewhat", as the controls speak them. `move` overrides the plan's arc, so its options are moves in `plan.ts`.
 * `toward DAE` picks the side of the argument bank the plan sees (`sourcesFor` in `text/live-plan.ts`), and the menu always offers it.
 */
export const CATALOG: Dimension[] = [
  { name: "toward DAE", kind: "scale", low: "supportive", high: "critical" },
  { name: "tension", kind: "scale", low: "", high: "" },
  { name: "stance", kind: "scale", low: "pragmatic", high: "radical" },
  { name: "purpose", kind: "scale", low: "commercial", high: "social" },
  { name: "method", kind: "scale", low: "hands-on", high: "theoretical" },
  { name: "stakeholders", kind: "choice", options: [] },
  { name: "move", kind: "choice", options: ["example", "objection", "consequence", "demand"] },
  { name: "tone", kind: "choice", options: ["urgent", "hopeful", "critical", "playful"] },
  { name: "perspective", kind: "scale", low: "singular", high: "pluralistic" },
  { name: "scope", kind: "scale", low: "individual", high: "collective" },
  { name: "horizon", kind: "scale", low: "present", high: "distant future" },
  { name: "technology", kind: "scale", low: "enthusiastic", high: "sceptical" },
  { name: "audience", kind: "choice", options: ["students", "educators", "institutions", "industry"] },
  { name: "register", kind: "scale", low: "plain", high: "academic" },
]

export const SYSTEM = `
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

export function userMessageOf({ text, leads }: DimensionContext, lens: string, axes: Dimension[], size: number) {
  const keyPhrases = leads.length ? `Key phrases:\n${leads.map(({ before, keyword, after }) => `- ${before}[${keyword}]${after}`).join("\n")}\n` : ""
  return `Manifesto: ${text}\n${keyPhrases}${lens ? `Lens: ${lens}\n` : ""}Axes:\n${axes.map(axisLine).join("\n")}\nPick ${size}.`
}

function axisLine(axis: Dimension) {
  if (axis.kind === "scale") return `${axis.name}: ${axis.low ? `${axis.low} | ${axis.high}` : SCALE_SLOT}`
  return `${axis.name}: ${axis.options.length ? axis.options.join(" | ") : CHOICE_SLOT}`
}
