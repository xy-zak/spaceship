import type { RealizationSource } from "./realization.ts"
import type { Span } from "./segments.ts"
import { endOf, isComplete, sentenceAt, sentenceUnderKnob, type StoryLayout } from "./story-layout.ts"

const REQUEST_DELAY_MS = 300
/** Only this many sentences after a tracking's origin are scored, to keep requests small. */
const MAX_SENTENCES = 20
/** Sentences before the first scored one, given as context. */
const CONTEXT_SENTENCES = 3
const MAX_CACHED = 1000

/** A control in words, e.g. "tension: very strained", tracked in the sentences starting at or after `origin` in the combined text. */
export type Tracking = { control: string; origin: number; controller: AbortController }

/**
 * Scores the complete sentences after each tracking's origin, including those generated past the main knob, so the confidence under the knob is known as soon as it moves.
 * Scores are cached by control and sentence, so only new sentences are asked about. Aborting a tracking's controller cancels its requests.
 */
export function createRealizationTracker(source: RealizationSource, onScore: () => void) {
  const confidences = new Map<string, number>()
  const asking = new Set<string>()
  let latest: { trackings: Tracking[]; story: StoryLayout } | undefined
  let timer: number | undefined

  return { score, realizedUnderKnob, realizedBeforeKnob }

  /** Requests at most once per `REQUEST_DELAY_MS`, for the latest text, so streaming and dragging still get scored as they go. */
  function score(trackings: Tracking[], story: StoryLayout) {
    latest = { trackings, story }
    timer ??= setTimeout(() => {
      timer = undefined
      latest?.trackings.forEach((tracking) => request(tracking, latest!.story))
    }, REQUEST_DELAY_MS)
  }

  /** The sentence the main knob is in and the confidence it delivers the control, once it is scored. */
  function realizedUnderKnob({ control, origin }: Tracking, story: StoryLayout): { sentence: Span; confidence: number } | undefined {
    const index = sentenceUnderKnob(story)
    const sentence = story.sentences[index]
    if (!sentence || sentence.start < origin || !isComplete(story, index)) return
    const confidence = confidences.get(keyOf(control, sentenceAt(story.combined, sentence)))
    return confidence === undefined ? undefined : { sentence, confidence }
  }

  /** The surest any sentence from the tracking's origin up to the main knob delivers the control, once one of them is scored. */
  function realizedBeforeKnob({ control, origin }: Tracking, { text, combined, sentences }: StoryLayout) {
    const knobAt = text.trimEnd().length
    const scores = sentences.flatMap((sentence) =>
      sentence.start >= origin && endOf(combined, sentence) <= knobAt ? [confidences.get(keyOf(control, sentenceAt(combined, sentence)))] : [],
    )
    const scored = scores.filter((score) => score !== undefined)
    return scored.length ? Math.max(...scored) : undefined
  }

  async function request({ control, origin, controller: { signal } }: Tracking, story: StoryLayout) {
    const { combined, sentences } = story
    const first = sentences.findIndex(({ start }) => start >= origin)
    if (signal.aborted || first === -1) return
    const candidates = sentences.slice(first, first + MAX_SENTENCES).filter((_, i) => isComplete(story, first + i))
    const texts = candidates.map((sentence) => sentenceAt(combined, sentence))
    const keys = texts.map((text) => keyOf(control, text))
    const asked = keys.flatMap((key, i) => (confidences.has(key) || asking.has(key) ? [] : [i]))
    if (!asked.length) return

    asked.forEach((i) => asking.add(keys[i]))
    const context = combined.slice(sentences[Math.max(0, first - CONTEXT_SENTENCES)].start, sentences[first].start).trim()
    try {
      for await (const { index, confidence } of source({ context, sentences: texts, asked, control }, signal)) remember(keys[index], confidence)
      if (!signal.aborted) onScore()
    } catch (error) {
      if (!signal.aborted) console.error(error)
    } finally {
      asked.forEach((i) => asking.delete(keys[i]))
    }
  }

  function remember(key: string, confidence: number) {
    confidences.set(key, confidence)
    if (confidences.size > MAX_CACHED) confidences.delete(confidences.keys().next().value!)
  }
}

function keyOf(control: string, sentence: string) {
  return JSON.stringify([control, sentence])
}
