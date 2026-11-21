import type { Station } from "./stations.ts"
import { firstWords } from "./text/words.ts"

/** `claim` is the one claim the turn's passage was planned to make, as "move: claim"; the claims of all turns are the manifesto's argument. */
export type Turn = { station: "opening" | Station; text: string; claim?: string }

export const wordsOf = (text: string) => text.match(/\S+/g) ?? []

/** The locked turns: every turn but the last, or the opening alone. */
export function floorOf(turns: Turn[]): Turn[] {
  return turns.length === 1 ? turns : turns.slice(0, -1)
}

/** A turn that starts a paragraph keeps its blank line instead of the joining space. */
export function joinTurns(turns: Turn[]): string {
  return turns
    .map((turn) => turn.text)
    .filter(Boolean)
    .join(" ")
    .replaceAll(" \n", "\n")
}

/** Single spaces between words and a blank line between paragraphs; a leading paragraph break is kept, as a turn may start a paragraph. */
export function tidySpace(text: string) {
  return text.trimEnd().replace(/\s+/g, (space, at: number) => (space.includes("\n") ? "\n\n" : at ? " " : ""))
}

/** The turns after `station` commits `tail`, or what the views show while it is still live text. The new turn keeps at most `wordLimit` words, and `claim` if it has any. */
export function appendTail(turns: Turn[], station: Station, tail: string, wordLimit: number | null = null, claim?: string): Turn[] {
  const { kept, fresh } = splitTail(turns, tail)
  const settled = turns.length === 1 ? turns : [...turns.slice(0, -1), { ...turns[turns.length - 1], text: kept }]
  const text = wordLimit === null ? fresh : firstWords(fresh, wordLimit)
  return [...settled, { station, text, ...(claim && text ? { claim } : {}) }]
}

export type AuthorRun = { station: Turn["station"]; words: number }

/** Who wrote each of the last `count` words of the turns, as runs oldest first. */
export function lastAuthors(turns: Turn[], count: number) {
  const runs: AuthorRun[] = []
  for (let i = turns.length - 1; i >= 0 && count > 0; i--) {
    const words = Math.min(count, wordsOf(turns[i].text).length)
    runs.unshift({ station: turns[i].station, words })
    count -= words
  }
  return runs
}

/**
 * `kept` is the tail's leading words that match the last turn's leading words (none when only the opening exists); `fresh` is the rest.
 * Both keep the tail's paragraph breaks, `fresh` a leading one too.
 */
export function splitTail(turns: Turn[], tail: string): { kept: string; fresh: string } {
  const tidy = tidySpace(tail)
  const tailWords = wordsOf(tidy)
  const lastWords = turns.length > 1 ? wordsOf(turns[turns.length - 1].text) : []
  let keptCount = 0
  while (keptCount < tailWords.length && tailWords[keptCount] === lastWords[keptCount]) keptCount++
  const kept = firstWords(tidy, keptCount)
  return { kept, fresh: tidy.slice(kept.length).replace(/^ /, "") }
}
