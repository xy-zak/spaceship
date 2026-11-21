import { streamCompletion } from "../llm/ollama.ts"
import { REQUEST, steeringBlocks, systemFor, userMessage } from "../prompts/manifesto.ts"
import type { Candidate } from "../prompts/plan.ts"
import { LENSES, type Station } from "../stations.ts"
import type { Turn } from "../turn-rules.ts"
import { moveOf, planPassage } from "./live-plan.ts"
import { filtered } from "./manifesto-filters.ts"
import type { Steering } from "./text-stream.ts"

/** The claim planned for one steering, with its move; undefined if the planner offered none. `waiters` wake once it `isDone`. */
type Plan = { move: string; candidate?: Candidate; isDone: boolean; controller: AbortController; waiters: Set<() => void> }

/** What the plan card shows: the move and the claim the next continuation writes, undefined while it is planned (`isDone` false) or if none came. */
export type PlanView = { move: string; candidate?: Candidate; isDone: boolean }

/**
 * Each station's editor gets the source for its own lens; without a station the prompt has none. `turns` gives the manifesto's turns, whose claims are the argument so far.
 * Each continuation writes a planned claim and its outline, planned once per steering, by `prepare` ahead of writing or else by the continuation itself; `reroll` drops it, so the next plans another.
 * `onPlan` is called whenever `plan()` changes; `claim()` is the one behind the latest continuation, which the commit stores with the turn.
 */
export function liveSourceFor(station?: Station, turns: () => Turn[] = () => [], onPlan: () => void = () => {}) {
  const plans = new Map<string, Plan>()
  /** Claims a reroll dropped, so new plans offer others. */
  const offered: string[] = []
  /** The steering of the latest continuation, as the prompts write it. */
  let key = ""
  let written: string | undefined

  return { complete, prepare, reroll, plan, claim: () => written }

  /** Plans the claim for `steering` without writing, unless it is planned already; the next continuation with the same steering writes it. */
  function prepare(prefix: string, steering: Steering) {
    key = steeringBlocks(steering)
    if (!plans.has(key)) startPlan(prefix, steering)
    onPlan()
  }

  async function* complete(prefix: string, steering: Steering, words: number, signal: AbortSignal) {
    key = steeringBlocks(steering)
    const plan = plans.get(key) ?? startPlan(prefix, steering)
    onPlan()
    const candidate = await candidateOf(plan, signal)
    written = candidate && `${plan.move}: ${candidate.claim}`
    const thesis = turns()
      .find(({ claim }) => claim)
      ?.claim?.replace(/^thesis: /, "")
    const system = systemFor({ lens: station && LENSES[station], thesis, move: candidate && plan.move, words })
    yield* filtered(prefix, streamCompletion({ ...REQUEST, system, user: userMessage(prefix, steering, candidate), signal }))
  }

  /** Drops the plan, so the next continuation plans a claim other than this one and those dropped before. */
  function reroll() {
    const plan = plans.get(key)
    if (!plan) return
    if (plan.candidate) offered.push(plan.candidate.claim)
    plan.controller.abort()
    plans.delete(key)
    onPlan()
  }

  function plan(): PlanView | undefined {
    const plan = plans.get(key)
    return plan && { move: plan.move, candidate: plan.candidate, isDone: plan.isDone }
  }

  /**
   * Plans apart from any one continuation, so one cut short leaves its plan to the next; only the latest steering's plan runs.
   * A failed plan leaves the passage unplanned, as before plans, and is asked again next time.
   */
  function startPlan(prefix: string, steering: Steering) {
    for (const [other, { isDone, controller }] of plans) {
      if (isDone) continue
      controller.abort()
      plans.delete(other)
    }
    const argument = turns().flatMap(({ claim }) => (claim ? [claim] : []))
    const plan: Plan = {
      move: moveOf(argument.length, steering.controls),
      isDone: false,
      controller: new AbortController(),
      waiters: new Set(),
    }
    const planKey = key
    plans.set(planKey, plan)
    const changed = () => {
      plan.waiters.forEach((wake) => wake())
      plan.waiters.clear()
      onPlan()
    }
    ;(async () => {
      try {
        plan.candidate = await planPassage({
          station,
          argument,
          offered: [...offered],
          prefix,
          steering: planKey,
          controls: steering.controls,
          move: plan.move,
          signal: plan.controller.signal,
        })
      } catch (error) {
        if ((error as Error).name !== "AbortError") console.error(error)
        if (plans.get(planKey) === plan) plans.delete(planKey)
      } finally {
        plan.isDone = true
        changed()
      }
    })()
    return plan
  }

  /** The plan's claim once planned; undefined if it offered none. */
  async function candidateOf(plan: Plan, signal: AbortSignal) {
    while (!plan.isDone) {
      signal.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        plan.waiters.add(resolve)
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
    }
    return plan.candidate
  }
}
