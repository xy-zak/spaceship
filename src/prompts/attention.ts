import { bulleted } from "./format.ts"

export const REQUEST = { temperature: 0.3, maxTokens: 1000 }
export const MAX_BOXES = 3

const RULES = [
  `Pick 1 to ${MAX_BOXES} phrases: 1 when a single phrase drives what comes next, more only when several do.`,
  "Each phrase is an exact, unbroken copy of 2 to 8 consecutive words from the manifesto. Do not skip, change, add or predict words.",
  "In every phrase, wrap the single word that matters most in [brackets].",
  "Output one phrase per line and nothing else.",
]

/** The parser in `text/live-attention.ts` reads one bracketed phrase per line. */
export const SYSTEM = `
The user message is the start of a manifesto on design education, cut off where the reader is. Pick the key phrases already in it that the very next words depend on most: the main influences on what comes right after the cut.

${bulleted(RULES)}

EXAMPLE
User: Design education must teach doubt before style. Every brief should end with a question the client did not ask. A studio is not a
Assistant:
teach [doubt] before style
a question the [client] did not ask
A [studio] is not a
`.trim()
