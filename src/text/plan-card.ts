import type { Point } from "../point.ts"
import type { PlanView } from "./live-completion.ts"
import type { RealizationSource } from "./realization.ts"
import { createRealizationTracker, type Tracking } from "./realization-tracker.ts"
import { endOf, type StoryLayout } from "./story-layout.ts"
import { firstWords } from "./words.ts"

/** A point counts as made once a shown sentence makes it this surely, as a future knob pins once its sentence is this sure. */
const MADE_CONFIDENCE = 0.8

type OutlinePoint = { control: string; item: HTMLLIElement; dot: HTMLElement; tracking?: Tracking }

/**
 * The card under the main knob, in `card`'s `<ol>`: the claim the text past the knob argues and its outline, a box each.
 * Each point, the claim first, fills as surely as a sentence of the passage shown so far makes it, scored like a future knob's control.
 */
export function createPlanCard(card: HTMLElement, realization: RealizationSource) {
  const list = card.querySelector("ol")!
  const tracker = createRealizationTracker(realization, () => story && follow(story, startWords))
  let points: OutlinePoint[] = []
  let shownClaim: string | undefined
  let story: StoryLayout | undefined
  let startWords = 0

  return { show, follow, placeAt }

  function show(plan: PlanView | undefined) {
    card.hidden = !plan || (plan.isDone && !plan.candidate)
    if (card.hidden || !plan) return clearPoints()
    const claim = plan.candidate?.claim
    if (claim === shownClaim && list.childElementCount) return
    clearPoints()
    shownClaim = claim
    if (!plan.candidate) return list.replaceChildren(Object.assign(document.createElement("li"), { textContent: "planning…", className: "planning" }))
    points = [{ label: "claim", text: plan.candidate.claim }, ...plan.candidate.points].map(({ label, text }) => pointOf(label, text))
    list.replaceChildren(...points.map(({ item }) => item))
    if (story) follow(story, startWords)
  }

  /** Takes the text as the knob or the generator changed it; the passage starts after its first `words` words, in the sentence that holds the next one. */
  function follow(next: StoryLayout, words: number) {
    story = next
    startWords = words
    const start = firstWords(next.combined, words).length
    const origin = next.sentences.find((sentence) => endOf(next.combined, sentence) > start)?.start ?? start
    for (const point of points) {
      point.tracking ??= { control: point.control, origin, controller: new AbortController() }
      const confidence = tracker.realizedBeforeKnob(point.tracking, next) ?? 0
      point.dot.style.setProperty("--fill", `${confidence}`)
      point.item.toggleAttribute("data-made", confidence >= MADE_CONFIDENCE)
    }
    tracker.score(
      points.flatMap(({ tracking }) => (tracking ? [tracking] : [])),
      next,
    )
  }

  /** Puts the card's top left corner at the page point `at`, as wide as the column. */
  function placeAt(at: Point, width: number) {
    card.style.translate = `${at.x}px ${at.y}px`
    card.style.width = `${width}px`
  }

  function clearPoints() {
    points.forEach(({ tracking }) => tracking?.controller.abort())
    points = []
    shownClaim = undefined
    list.replaceChildren()
  }
}

/** A point is scored as a control whose value is its text, e.g. "because: tutors are paid by the hour". */
function pointOf(label: string, text: string): OutlinePoint {
  const item = document.createElement("li")
  const dot = document.createElement("span")
  item.append(dot, Object.assign(document.createElement("b"), { textContent: label }), ` ${text}`)
  return { control: `${label}: ${text}`, item, dot }
}
