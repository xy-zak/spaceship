import assert from "node:assert/strict"
import { test } from "node:test"
import { stepStates } from "./steps.ts"

test("routes and terms are current together while steering, then done or skipped as the plan and the writing follow", () => {
  assert.deepEqual(stepStates("steer", new Set(), false), { routes: "current", terms: "current", plan: "next", write: "next" })
  assert.deepEqual(stepStates("plan", new Set(["terms"]), false), { routes: "skipped", terms: "done", plan: "current", write: "next" })
  assert.deepEqual(stepStates("write", new Set(["routes"]), false), { routes: "done", terms: "skipped", plan: "done", write: "current" })
})

test("on the first turn terms are unavailable, unless the reader weighs the opening anyway", () => {
  assert.deepEqual(stepStates("steer", new Set(), true), { routes: "current", terms: "unavailable", plan: "next", write: "next" })
  assert.deepEqual(stepStates("plan", new Set(["terms"]), true), { routes: "skipped", terms: "done", plan: "current", write: "next" })
})
