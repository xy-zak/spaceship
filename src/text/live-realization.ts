import { linesOf, streamCompletion } from "../llm/ollama.ts"
import { MAX_SCORE, REQUEST, SYSTEM, userOf } from "../prompts/realization.ts"
import type { RealizationSource } from "./realization.ts"

/** Scores come back as "number: score" lines; lines that don't parse, and numbers that weren't asked, are ignored. */
export const liveRealization: RealizationSource = async function* (request, signal) {
  for await (const line of linesOf(streamCompletion({ ...REQUEST, system: SYSTEM, user: userOf(request), signal }))) {
    const match = line.trim().match(/^\[?(\d+)\]?\s*[:=]\s*(\d+)/)
    const index = Number(match?.[1]) - 1
    if (match && request.asked.includes(index)) yield { index, confidence: Math.min(Number(match[2]), MAX_SCORE) / MAX_SCORE }
  }
}
