import { linesOf, streamCompletion } from "../llm/ollama.ts"
import type { RealizationSource } from "./realization.ts"

const MAX_SCORE = 10

const SYSTEM_PROMPT = `
The user message has the manifesto so far, numbered sentences that follow it, a CONTROL (a quality the writing was steered toward, e.g. "stance: very radical") and the numbers to score.

For each number to score, rate from 0 to ${MAX_SCORE} how clearly that sentence shows the control's value: 0 when it does not show it or shows the opposite, ${MAX_SCORE} when a reader would notice it at once. Judge each sentence on its own words, using the rest only as context. Output one line per number as "number: score", and nothing else.

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

/** Scores come back as "number: score" lines; lines that don't parse, and numbers that weren't asked, are ignored. */
export const liveRealization: RealizationSource = async function* ({ context, sentences, asked, control }, signal) {
  const user = [
    ...(context ? [`MANIFESTO SO FAR\n${context}`] : []),
    `SENTENCES\n${sentences.map((sentence, i) => `[${i + 1}] ${sentence}`).join("\n")}`,
    `CONTROL\n${control}`,
    `SCORE\n${asked.map((index) => index + 1).join(", ")}`,
  ].join("\n\n")

  for await (const line of linesOf(streamCompletion({ system: SYSTEM_PROMPT, user, temperature: 0, maxTokens: 1000, signal }))) {
    const match = line.trim().match(/^\[?(\d+)\]?\s*[:=]\s*(\d+)/)
    const index = Number(match?.[1]) - 1
    if (match && asked.includes(index)) yield { index, confidence: Math.min(Number(match[2]), MAX_SCORE) / MAX_SCORE }
  }
}
