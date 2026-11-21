import type { RealizationRequest } from "../text/realization.ts"

export const REQUEST = { temperature: 0, maxTokens: 1000 }
export const MAX_SCORE = 10

/** The parser in `text/live-realization.ts` reads the "number: score" lines. */
export const SYSTEM = `
The user message has the manifesto so far, numbered sentences that follow it, a CONTROL (a quality the writing was steered toward, e.g. "stance: very radical", or a point it was planned to make, e.g. "because: tutors are paid by the hour") and the numbers to score.

For each number to score, rate from 0 to ${MAX_SCORE} how clearly that sentence shows the control's value or makes its point: 0 when it does not, or shows the opposite, ${MAX_SCORE} when a reader would notice it at once. Judge each sentence on its own words, using the rest only as context. Output one line per number as "number: score", and nothing else.

EXAMPLE
User:
MANIFESTO SO FAR
Design education must teach doubt before style.

SENTENCES
[1] Tear up the syllabus every September and let the first-years write the next one.
[2] Each module is reviewed once a year by the curriculum committee.

CONTROL
stance: very radical

SCORE
1, 2
Assistant:
1: 9
2: 1
`.trim()

export function userOf({ context, sentences, asked, control }: RealizationRequest) {
  return [
    ...(context ? [`MANIFESTO SO FAR\n${context}`] : []),
    `SENTENCES\n${sentences.map((sentence, i) => `[${i + 1}] ${sentence}`).join("\n")}`,
    `CONTROL\n${control}`,
    `SCORE\n${asked.map((index) => index + 1).join(", ")}`,
  ].join("\n\n")
}
