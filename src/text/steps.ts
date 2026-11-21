/** A turn's steps in order, as the `data-step` of the step bar's items. */
const STEPS = ["routes", "terms", "plan", "write"] as const
export type Step = (typeof STEPS)[number]
export type StepState = "current" | "done" | "skipped" | "next" | "unavailable"
/** Where a turn is; Enter moves it on. Steering sets the optional routes and terms together, then the plan is made, then the text is written. */
export type Phase = "steer" | "plan" | "write"

/** Marks each item of the step bar `list`; `done` holds the optional steps the reader set something in. */
export function showSteps(list: HTMLElement, phase: Phase, done: Set<Step>, isFirstTurn: boolean) {
  const states = stepStates(phase, done, isFirstTurn)
  for (const item of list.querySelectorAll<HTMLElement>("[data-step]")) {
    const state = states[item.dataset.step as Step]
    item.dataset.state = state
    if (state === "current") item.setAttribute("aria-current", "step")
    else item.removeAttribute("aria-current")
  }
}

/**
 * Routes and terms are both current while steering, then done or skipped; the plan and the writing are current in their phase.
 * Terms are unavailable on the first turn, which has no prose to weigh, unless the reader weighs the opening anyway.
 */
export function stepStates(phase: Phase, done: Set<Step>, isFirstTurn: boolean): Record<Step, StepState> {
  const optional = (step: Step): StepState => {
    if (step === "terms" && isFirstTurn && !done.has(step)) return "unavailable"
    if (phase === "steer") return "current"
    return done.has(step) ? "done" : "skipped"
  }
  return {
    routes: optional("routes"),
    terms: optional("terms"),
    plan: phase === "plan" ? "current" : phase === "write" ? "done" : "next",
    write: phase === "write" ? "current" : "next",
  }
}
