export const STATIONS = ["B", "C", "D"] as const
export type Station = (typeof STATIONS)[number]
export const OPENING = "Design education must"
export const MODEL = "gpt-oss:20b"
export const LENSES: Record<Station, string> = {
  B: "how design is taught",
  C: "who design education serves",
  D: "what design education is for",
}

export function nextStation(station: Station): Station {
  return STATIONS[(STATIONS.indexOf(station) + 1) % STATIONS.length]
}
