import { panAt, play, startBed, type Sound, type Voice } from "./engine.ts"

/**
 * The text app's sounds, as chosen on extra/soundboard.html. Every function takes the page x the sound comes from, for stereo pan.
 * The hand clicks (filtered-noise transients); the model speaks in FM blips; a settled state ends on a plain sine. Pitches share one E-major pentatonic scale.
 * Text generation itself is silent: it starts and stops too often to be worth hearing.
 */

/** Must match `--pin` in the page styles: a pinned knob's travel to the margin, after which its sound lands. */
const PIN_TRAVEL_SECONDS = 0.6
/**
 * Words the knob reveals or removes tick one by one, like the detents of a ratchet: ticks fall `WORD_GAP_MS` apart, closing up to
 * `MIN_WORD_GAP_MS` when a long stride would otherwise run behind the hand, never closer, so each tick stays distinct. The queue never runs
 * more than `MAX_WORD_LAG_MS` behind the hand: a long stride plays at most seven, and a move that finds the queue full replaces what is not yet heard.
 */
const WORD_GAP_MS = 30
const MIN_WORD_GAP_MS = 25
const MAX_WORD_LAG_MS = 160
/** Boxes revealed together still sound one after another, this far apart. */
const CASCADE_GAP_MS = 45
const PENTATONIC = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3]

/** note(0) = E4, note(5) = E5, note(10) = E6, note(15) = E7. */
const note = (degree: number) => 329.63 * 2 ** Math.floor(degree / 5) * PENTATONIC[((degree % 5) + 5) % 5]
const click = (f: number, gain: number, more: Partial<Voice> = {}): Voice => ({ filter: "bandpass", f, q: 3, decay: 0.005, gain, ...more })
const at = (x: number, voices: Voice[]) => play(voices.map((voice) => ({ pan: panAt(x), ...voice })))
const latch = (x: number, first: number, second: number, gains: [number, number]) => at(x, [click(first, gains[0]), click(second, gains[1], { delay: 0.012 })])

/** All 0 to 1, but `x`, the page x. */
export type DragBed = { move(position: number, strength: number, speed: number, x: number): void; stop(): void }

/** When the next word tick may sound; and the batches queued, with when each tick sounds, which give way when a new move finds no room. */
let nextWordAt = -Infinity
let wordTicks: { sound: Sound; times: number[] }[] = []
let cascadeAt = -Infinity

export const sounds = {
  /** The pointer enters the main knob. */
  knobHover: (x: number) => at(x, [{ filter: "highpass", f: 6500, q: 0.7, decay: 0.008, gain: 0.1 }]),
  knobGrab: (x: number) => latch(x, 2200, 3200, [0.35, 0.25]),
  knobRelease: (x: number) => latch(x, 3200, 2200, [0.25, 0.3]),

  /** The dragged caret crosses `count` words: forward reveals them, back removes them, one tick each. The most frequent sound, so the quietest; softer the faster the drag. */
  word(direction: number, count: number, speed: number, x: number) {
    const now = performance.now()
    let start = Math.max(now, nextWordAt)
    // The latest move matters most: when the queue has no room for it, the backlog not yet heard gives way,
    // and the new ticks follow the last one heard no closer than any two ticks, so none fuse into one click.
    if (start - now > MAX_WORD_LAG_MS - MIN_WORD_GAP_MS) {
      const heard = wordTicks.flatMap(({ times }) => times.filter((time) => time <= now))
      wordTicks.forEach(({ sound }) => sound.stop())
      wordTicks = []
      start = Math.max(now, ...heard.map((time) => time + MIN_WORD_GAP_MS))
    }
    wordTicks = wordTicks.filter(({ times }) => times.at(-1)! > now)
    const room = now + MAX_WORD_LAG_MS - start
    const gap = Math.max(MIN_WORD_GAP_MS, Math.min(WORD_GAP_MS, room / count))
    const ticks = Math.min(count, Math.floor(room / gap) + 1)
    const tick: Voice = { filter: "bandpass", f: direction > 0 ? 2400 : 1800, q: 2, decay: 0.003, gain: 0.1 * (1 - 0.3 * clamp01(speed)) }
    const times = Array.from({ length: ticks }, (_, i) => start + i * gap)
    wordTicks.push({
      sound: at(
        x,
        times.map((time) => ({ ...tick, delay: (time - now) / 1000 })),
      ),
      times,
    })
    nextWordAt = start + ticks * gap
  },

  /** A dashed future knob appears; `remove` mirrors it. */
  spawn: (x: number) =>
    at(x, [
      { filter: "highpass", f: 5000, decay: 0.006, gain: 0.18 },
      { filter: "highpass", f: 5000, decay: 0.006, gain: 0.18, delay: 0.045 },
      { f: note(12), decay: 0.03, gain: 0.05, delay: 0.045 },
    ]),

  /** Every deletion: a box, a future knob, a pinned knob undone. */
  remove: (x: number) =>
    at(x, [
      { filter: "highpass", f: 5000, decay: 0.006, gain: 0.18 },
      { filter: "highpass", f: 3500, decay: 0.006, gain: 0.12, delay: 0.04 },
    ]),

  /** The `index`th box of an expansion arrives; each sounds a step higher. */
  boxRevealed(index: number, x: number) {
    const now = performance.now()
    cascadeAt = Math.max(now, cascadeAt + CASCADE_GAP_MS)
    at(x, [{ f: note(8 + Math.min(index, 5) * 2), decay: 0.03, gain: 0.07, delay: (cascadeAt - now) / 1000 }])
  },

  /** Every box and future knob detached at once. */
  collapse: (x: number) =>
    at(
      x,
      [12, 9, 5].map((degree, i) => ({ f: note(degree), decay: 0.03, gain: 0.07, delay: i * 0.035 })),
    ),

  /** Holds while a future knob waits for its menu; stop it when the menu arrives. */
  menuLoading: (x: number): Sound => at(x, [{ f: 1320, lfoRate: 14, lfoDepth: 180, attack: 0.02, hold: 10, decay: 0.05, gain: 0.02 }]),
  menuReady: (x: number) => at(x, [{ f: note(15), index: 2, decay: 0.06, gain: 0.07 }]),
  menuFailed: (x: number) =>
    at(x, [
      { f: 196, wave: "square", decay: 0.05, gain: 0.025 },
      { f: 196, wave: "square", decay: 0.05, gain: 0.025, delay: 0.08 },
    ]),

  /** While choosing, the knob enters another dimension's sector; each sector has its own pitch. */
  candidate: (index: number, x: number) => at(x, [click(2400, 0.12, { decay: 0.003 }), { f: note(5 + index * 2), decay: 0.02, gain: 0.06 }]),
  /** The knob is carried through the gate and takes the dimension. */
  take: (x: number) =>
    at(x, [
      click(1800, 0.3),
      click(3000, 0.2, { delay: 0.01 }),
      { f: note(10), decay: 0.04, gain: 0.08, delay: 0.015 },
      { f: note(14), decay: 0.08, gain: 0.07, delay: 0.05 },
    ]),
  /** Tuning a scale, the knob crosses one of the rim's graduations: the pitch rises across the fan, major ones louder with a click. */
  graduation(fraction: number, isMajor: boolean, x: number) {
    const voices: Voice[] = [{ f: 330 * 2 ** (fraction * 2), decay: 0.012, gain: isMajor ? 0.07 : 0.03 }]
    if (isMajor) voices.push(click(2400, 0.2))
    at(x, voices)
  },
  /** Tuning a choice, the knob enters another option's sector. */
  sector: (index: number, x: number) => at(x, [click(1800, 0.3), { f: note(5 + index * 3), decay: 0.04, gain: 0.07 }]),
  /** The knob crosses a step of strength, `step` of `steps`; louder the stronger, with a body at full strength. */
  ruler(step: number, steps: number, x: number) {
    const voices: Voice[] = [click(2000, 0.06 + (step / steps) * 0.3, { decay: 0.004 })]
    if (step === steps) voices.push({ f: 110, decay: 0.04, gain: 0.25 })
    at(x, voices)
  },
  /** Clicks for as long as a future knob is dragged: faster the stronger, higher further across the fan, louder the faster it moves. */
  bed(position: number, strength: number, x: number): DragBed {
    const bed = startBed({ position, strength, speed: 0, pan: panAt(x) })
    return { move: (position, strength, speed, x) => bed.set({ position, strength, speed, pan: panAt(x) }), stop: bed.stop }
  },
  /** A tuned knob is dropped and the model starts measuring it: the hand hands off. */
  handOff: (x: number) => at(x, [click(3000, 0.2), click(2000, 0.25, { delay: 0.012 }), { f: note(10), index: 1.2, decay: 0.04, gain: 0.06, delay: 0.04 }]),
  /** A realization score arrives; the pitch is the score. */
  realized: (confidence: number, x: number) => at(x, [{ f: note(5 + Math.round(confidence * 10)), index: 1.2, decay: 0.04, gain: 0.06 }]),
  /** A realized knob lands in its margin pin: two notes resolving upward. */
  pin: (x: number) =>
    at(x, [
      { f: note(13), attack: 0.003, decay: 0.1, gain: 0.06, delay: PIN_TRAVEL_SECONDS },
      { f: note(15), attack: 0.003, decay: 0.3, gain: 0.07, delay: PIN_TRAVEL_SECONDS + 0.07 },
    ]),

  boxHover: (x: number) => at(x, [{ filter: "highpass", f: 7000, q: 0.7, decay: 0.006, gain: 0.08 }]),
  boxGrab: (x: number) => latch(x, 2000, 2800, [0.3, 0.2]),
  /** A dragged box's keyword moves to another word. */
  boxHop: (x: number) => at(x, [click(2800, 0.25, { decay: 0.004 })]),
  boxDrop: (x: number) => latch(x, 2800, 2000, [0.2, 0.25]),
  /** A text selection becomes a box. */
  boxCreate: (x: number) =>
    at(x, [click(2400, 0.2), { f: note(10), decay: 0.03, gain: 0.07, delay: 0.01 }, { f: note(14), decay: 0.04, gain: 0.06, delay: 0.05 }]),
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value))
}
