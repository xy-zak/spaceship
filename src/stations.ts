export const STATIONS = ["B", "C", "D"] as const
export type Station = (typeof STATIONS)[number]
export const OPENING = "Design education must"
export const MODEL = "gpt-oss:20b"
/** How many new words a station may add in one turn, by the preset the server is started with (`WORD_LIMIT`); null is no limit. */
export const WORD_LIMITS = { short: 50, medium: 100, long: 200, unlimited: null } as const
export const DEFAULT_WORD_LIMIT = "medium"
export const LENSES: Record<Station, string> = {
  B: "how design is taught",
  C: "who design education serves",
  D: "what design education is for",
}

export function nextStation(station: Station): Station {
  return STATIONS[(STATIONS.indexOf(station) + 1) % STATIONS.length]
}
