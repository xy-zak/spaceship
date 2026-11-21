import type { Lead } from "./attention.ts"
import type { Control } from "./dimension.ts"
import { countWords, firstWords } from "./words.ts"

export type GenerationTrigger = "buffer low" | "steering changed"

/** How a call to `generate` ended: `busy` if another generation was running, `aborted` if cut short by `truncate` or `regenerate`. */
export type GenerationOutcome = "busy" | "aborted" | "done"

/** What leads a continuation: key phrases from the text, and dimensions tuned for what comes next. Either may be empty. */
export type Steering = { leads: Lead[]; controls: Control[] }

export type TextSource = {
  /**
   * Streams text that continues `prefix`, led by `steering`.
   * Must stop (by throwing or returning) once `signal` aborts.
   */
  complete(prefix: string, steering: Steering, signal: AbortSignal): AsyncIterable<string>
}

/** How the latest generation went: whether it is still running, how long its first chunk took, and how fast words arrived after that. */
export type StreamActivity = { isGenerating: boolean; firstChunkMs?: number; wordsPerSecond?: number }

/** Times of the latest generation; `words` counts those after the first chunk, so the rate measures streaming, not latency. */
type Timing = { startedAt: number; firstChunkAt?: number; lastChunkAt?: number; words: number }

/** What the stream starts from: `text` is shown, its first `floorWords` words are locked, and `head` is earlier text only the model sees. */
export type Seed = { head: string; text: string; floorWords: number }

/** `onChange` is called whenever the text changes and once a generation finishes. */
export function createTextStream({ complete }: TextSource, onChange: () => void) {
  let text = ""
  let head = ""
  let active: AbortController | undefined
  let id = 0
  let floorWords = 0
  let timing: Timing | undefined
  /** Waiting for the current generation to start streaming. */
  const waiters = new Set<() => void>()

  return {
    get text() {
      return text
    },
    get floorWords() {
      return floorWords
    },
    seed,
    generate,
    truncate,
    regenerate,
    activity,
    streaming,
  }

  /**
   * Resolves once the current generation has its first chunk, or ends without one; at once if none is running.
   * Lesser requests to the same API wait for this, so they never compete with the continuation for the server's rate limit or its time to first chunk.
   * A generation cancelled to start another hands its waiters on to the new one.
   */
  function streaming() {
    if (!active || timing?.firstChunkAt !== undefined) return Promise.resolve()
    return new Promise<void>((resolve) => waiters.add(resolve))
  }

  function release() {
    for (const resolve of waiters) resolve()
    waiters.clear()
  }

  function activity(): StreamActivity {
    if (!timing) return { isGenerating: false }
    const { startedAt, firstChunkAt, lastChunkAt, words } = timing
    const streamingMs = firstChunkAt === undefined || lastChunkAt === undefined ? 0 : lastChunkAt - firstChunkAt
    return {
      isGenerating: active !== undefined,
      firstChunkMs: firstChunkAt === undefined ? undefined : firstChunkAt - startedAt,
      wordsPerSecond: streamingMs > 0 ? (words * 1000) / streamingMs : undefined,
    }
  }

  /** Continues the text from its end, appending; never rewrites it. Rejects if the source fails. */
  async function generate(trigger: GenerationTrigger, steering: Steering): Promise<GenerationOutcome> {
    if (active) return "busy"

    const controller = (active = new AbortController())
    const { signal } = controller
    const generationId = ++id
    const prefix = text
    const started: Timing = { startedAt: performance.now(), words: 0 }
    timing = started
    console.log(`generation ${generationId} start by ${trigger} after ${countWords(prefix)} words`)

    try {
      for await (const chunk of complete(head ? `${head} ${prefix}` : prefix, steering, signal)) {
        if (signal.aborted) return "aborted"
        const now = performance.now()
        if (started.firstChunkAt === undefined) {
          started.firstChunkAt = now
          release()
        } else started.words += countWords(chunk)
        started.lastChunkAt = now
        text += chunk
        onChange()
      }
      if (signal.aborted) return "aborted"
      console.log(`generation ${generationId} done with ${countWords(text) - countWords(prefix)} words`)
      return "done"
    } catch (error) {
      if (!signal.aborted) throw error
      return "aborted"
    } finally {
      if (active === controller) {
        active = undefined
        release()
        onChange()
      }
    }
  }

  function seed(next: Seed) {
    cancel()
    head = next.head
    text = next.text
    floorWords = next.floorWords
    onChange()
  }

  /** Never cuts into the floor. */
  function truncate(count: number) {
    cancel()
    text = firstWords(text, Math.max(count, floorWords))
  }

  function regenerate(count: number, trigger: GenerationTrigger, steering: Steering) {
    truncate(count)
    return generate(trigger, steering)
  }

  function cancel() {
    if (!active) return
    active.abort()
    active = undefined
    console.log(`generation ${id} cancel`)
  }
}
