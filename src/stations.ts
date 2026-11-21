export const STATIONS = ["B", "C", "D"] as const
export type Station = (typeof STATIONS)[number]
export const OPENING = "Design education must"
export const MODEL = "gpt-oss:20b"
/** How many new words a station may add in one turn, by the preset the server is started with (`WORD_LIMIT`); null is no limit. */
export const WORD_LIMITS = { short: 50, medium: 100, long: 200, unlimited: null } as const
export const DEFAULT_WORD_LIMIT = "medium"
/** Leave a lens empty to drop that station's identity from the prompts. */
export const LENSES: Record<Station, string> = {
  B: "how design is taught",
  C: "who design education serves",
  D: "what design education is for",
}
/** What the continuation prompt asks each lens to draw on, from both sides of the debates in DAE's Institutional Plan 2025-2028. */
export const LENS_THEMES: Record<Station, string> = {
  B: "studios and fundamentals, briefs and crits, workshops, tools and materials, labs and research, process over perfection, AI at the workbench, the graduation show",
  C: "students of every background and income, tutors and freelance staff, a transient international community of communities, the city and its new design district, Brainport industry and government, the market and those it leaves out, learners beyond the degree",
  D: "design as a social and cultural practice or as an engine of innovation, policy and systems change, sustainability beyond quick fixes, the planet, radical imagination, impact outside the academy, what we inherit and what we leave behind",
}

export function nextStation(station: Station): Station {
  return STATIONS[(STATIONS.indexOf(station) + 1) % STATIONS.length]
}
