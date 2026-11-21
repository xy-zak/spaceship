import type { Station } from "./stations.ts"

export type Turn = { station: "opening" | Station; text: string }

export const wordsOf = (text: string) => text.match(/\S+/g) ?? []

/** The locked turns: every turn but the last, or the opening alone. */
export function floorOf(turns: Turn[]): Turn[] {
  return turns.length === 1 ? turns : turns.slice(0, -1)
}

export function joinTurns(turns: Turn[]): string {
  return turns
    .map((turn) => turn.text)
    .filter(Boolean)
    .join(" ")
}

/** `kept` is the tail's leading words that match the last turn's leading words (none when only the opening exists); `fresh` is the rest. */
export function splitTail(turns: Turn[], tail: string): { kept: string; fresh: string } {
  const tailWords = wordsOf(tail)
  const lastWords = turns.length > 1 ? wordsOf(turns[turns.length - 1].text) : []
  let keptCount = 0
  while (keptCount < tailWords.length && tailWords[keptCount] === lastWords[keptCount]) keptCount++
  return { kept: tailWords.slice(0, keptCount).join(" "), fresh: tailWords.slice(keptCount).join(" ") }
}
