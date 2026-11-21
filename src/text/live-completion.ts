import { streamCompletion } from "../llm/ollama.ts"
import { REQUEST, steeringBlocks, systemFor, userMessage } from "../prompts/manifesto.ts"
import { CANDIDATES, type Candidate } from "../prompts/plan.ts"
import { LENSES, type Station } from "../stations.ts"
import type { Turn } from "../turn-rules.ts"
import { moveOf, planPassage } from "./live-plan.ts"
import { filtered } from "./manifesto-filters.ts"
import type { Steering } from "./text-stream.ts"

/** The claims planned for one steering: its move and the candidates offered so far, all of them once `isDone`. `waiters` wake on every change. */
type Plan = { move: string; candidates: Candidate[]; isDone: boolean; controller: AbortController; waiters: Set<() => void> }

/** What the plan card shows: the move, the candidate the next continuation writes (undefined while it is planned), its place among the candidates and how many there are. */
export type PlanView = { move: string; candidate?: Candidate; index: number; count: number }

/**
 * Each station's editor gets the source for its own lens; without a station the prompt has none. `turns` gives the manifesto's turns, whose claims are the argument so far.
 * Each continuation writes a planned claim and its outline. One plan per steering offers `CANDIDATES` of them; `reroll` steps to the next, and past the last asks for new ones.
 * The place reroll reached is kept when the steering changes. `onPlan` is called whenever `plan()` changes; `claim()` is the one behind the latest continuation, which the commit stores with the turn.
 */
export function liveSourceFor(station?: Station, turns: () => Turn[] = () => [], onPlan: () => void = () => {}) {
  const plans = new Map<string, Plan>()
  /** Claims passed over by rerolling past the last candidate, so new plans offer others. */
  const offered: string[] = []
  /** The steering of the latest continuation, as the prompts write it. */
  let key = ""
  let index = 0
  let written: string | undefined

  return { complete, reroll, plan, claim: () => written }

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

  /** Steps to the next candidate; past the last, drops the plan, so the next continuation plans claims other than these. */
  function reroll() {
    const plan = plans.get(key)
    if (!plan) return
    if (index + 1 < (plan.isDone ? plan.candidates.length : CANDIDATES)) index++
    else {
      offered.push(...plan.candidates.map(({ claim }) => claim))
      plan.controller.abort()
      plans.delete(key)
      index = 0
    }
    onPlan()
  }

  function plan(): PlanView | undefined {
    const plan = plans.get(key)
    if (!plan) return
    const count = plan.isDone ? plan.candidates.length : CANDIDATES
    const shown = Math.min(index, count - 1)
    return { move: plan.move, candidate: plan.candidates[shown], index: shown, count }
  }

  /**
   * Plans apart from any one continuation, so one cut short leaves its plan to the next; only the latest steering's plan runs.
   * A failed plan leaves the passage unplanned, as before plans, and is asked again next time unless it offered something.
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
      candidates: [],
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
        const candidates = planPassage({
          station,
          argument,
          offered: [...offered],
          prefix,
          steering: planKey,
          controls: steering.controls,
          move: plan.move,
          signal: plan.controller.signal,
        })
        for await (const candidate of candidates) {
          plan.candidates.push(candidate)
          changed()
        }
      } catch (error) {
        if ((error as Error).name !== "AbortError") console.error(error)
        if (!plan.candidates.length && plans.get(planKey) === plan) plans.delete(planKey)
      } finally {
        plan.isDone = true
        changed()
      }
    })()
    return plan
  }

  /** The candidate at the place reroll reached, once planned, or the last one if the plan offered fewer; undefined if it offered none. */
  async function candidateOf(plan: Plan, signal: AbortSignal) {
    while (plan.candidates.length <= index && !plan.isDone) {
      signal.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        plan.waiters.add(resolve)
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
    }
    return plan.candidates[Math.min(index, plan.candidates.length - 1)]
  }
}
