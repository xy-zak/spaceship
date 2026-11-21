import { strengthLevelOf, valueOf, type Control } from "../text/dimension.ts"
import type { Steering } from "../text/text-stream.ts"
import { bulleted } from "./format.ts"
import { MOVES, type Candidate } from "./plan.ts"

/** Thinking models spend these tokens on reasoning too, so they stay generous; the editor stops the stream once it has the words it asked for. */
export const REQUEST = { temperature: 0.9, maxTokens: 2000 }
/** How much of the manifesto the writer sees; the plan carries the argument before it, and every earlier phrase is one more for a small model to copy. */
const MANIFESTO_WORDS = 300

const INTRO =
  "Continue the manifesto on design education. The user message may list KEY PHRASES, CONTROLS, the CLAIM TO MAKE and its OUTLINE, then the MANIFESTO SO FAR, which may stop mid-sentence."

const CONTEXT_NOTE =
  "The manifesto's setting is Design Academy Eindhoven (DAE). Its Institutional Plan 2025-2028 and annual reports 2021-2025 are background, never to be quoted: the manifesto may take up, sharpen or reject its positions. Use the context sparingly: most passages need none of it, and the manifesto names a place at most once."

const CONTEXT = [
  "A small, independent, international academy, more than 75 years old. Bachelor students work in studios, each a different approach to research and making, beside the fundamentals. The master is becoming research labs; an associate degree in immersive design starts in 2027.",
  "In 2028 it moves to a new campus in Eindhoven, with housing for first-years, in the Brainport region of technology, industry and government partners.",
  "It faces the climate crisis, AI as a design tool, growing inequality, and politics that question international institutions and the funding of progressive ideas.",
  "The Institutional Plan holds that design is first a social and cultural practice, and only then a tool for innovation; that thinking and making belong together; that many voices and ways of knowing beat a single canon; that design must look beyond the market; that the right questions come before solutions.",
  "Against it pull the need to prepare graduates for jobs and industry, to fund the school through partners and innovation, and to judge design by what the market takes up.",
]

const VOICE = [
  'A manifesto: claims a reader could argue with, in the present tense, mostly short. Mix demands with "must" and "we" with plain statements, definitions and questions: at most a third of the sentences use "must". Vary their shape: a demand, a definition, a question, a list, an example.',
  'State every claim directly, and never use the word "not" or "n\'t", nor "rather than" or "instead of": a claim set against a foil is the most common tell of machine writing.',
  "The language of design education, as the Institutional Plan speaks it: studio, lab, brief, crit, material, praxis, discourse. Say what should change and why, in plain words: at most one concrete example and one image per passage, never a numbered or named studio, and let no word or image become a refrain.",
  'The Institutional Plan\'s moves: pairs ("thinking and making"), spans ("from a single studio to the planet"), questions before answers. Use its moves, never its sentences.',
]

const RULES = [
  'Output only the words that come next in the manifesto. Your first word directly follows the manifesto\'s last word: if it stops mid-sentence, finish that sentence first; if its last sentence is complete but lacks its full stop, start with the full stop. Never repeat or restart any of the manifesto so far, not even its last word: after "…a timetable should name its" write "riders, …", never "its riders" or "A timetable should name its riders".',
  "Writers take turns on the manifesto, each from their own lens, so its last claim is another writer's: build on it without restating it. Never copy a sentence, or any run of four words, from the manifesto so far, and never return to a place, image or example it has already used.",
  "Key phrases lead what comes next: build the continuation on them, most of all on the [bracketed] words.",
  "Controls set how the next passage reads. Each is a dimension given only by its name and its poles or options, so infer from the labels what to change in the claims, focus or style. A scale gives a position between two poles: at an extreme, exaggerate that pole so a reader notices it within two sentences; midway, balance both. A choice names the option to follow. Each control ends with a strength in parentheses that sets how much it shapes the passage. Strong: it dominates every sentence. Moderate: a clear influence throughout. Slight: show it in one or two touches only, such as a single sentence or image, and otherwise write the passage as the manifesto's own argument, the key phrases and the stronger controls would have it; a slight control must never set the overall character of the passage. Strength is separate from the value and replaces the exaggeration rule: exaggerate a pole only at strong. Obey every control from the first sentence to the last, but never write a label itself as words of the manifesto.",
  "With both, key phrases are the content and controls are the manner: what comes next grows out of the key phrases, whose bracketed words appear in the first two sentences, written in the controlled manner.",
  "Plain text only. No title, markdown or commentary.",
  "Write in paragraphs of three to six sentences, with a blank line where the thought turns. Never put a sentence on a line of its own.",
  "End on a complete sentence.",
]

/**
 * On another subject, and without key phrases, so the model takes its form and none of its words:
 * qwen copied a design-education example into the manifesto even reworded, and took the example's key phrase for a real one.
 */
const EXAMPLE = {
  controls: [{ dimension: { name: "stance", kind: "scale", low: "pragmatic", high: "radical" }, position: 0, strength: 1 }] satisfies Control[],
  candidate: {
    claim: "A timetable must be built around its riders' shifts and transfers.",
    points: [
      { label: "because", text: "a rider loses more of the day to waiting than to riding" },
      { label: "for instance", text: "the waits at every stop, counted beside the rides" },
      { label: "so", text: "each wait gets a published cost in minutes and fares" },
    ],
  } satisfies Candidate,
  manifesto: "A city runs on its buses. A timetable should name its riders",
  reply:
    ", their shifts and their transfers before it names a speed. A rider loses more of the day to waiting than to riding. Count the waits at every stop as well as the rides, and publish what each costs in minutes and fares.",
}
/** Every word of the example the model sees, which it must never copy into the manifesto. */
export const EXAMPLE_TEXT = [EXAMPLE.manifesto, EXAMPLE.candidate.claim, ...EXAMPLE.candidate.points.map(({ text }) => text), EXAMPLE.reply].join("\n")

/** The part every station shares comes first, so Ollama can reuse its cached prefix. */
const SYSTEM = [
  INTRO,
  `CONTEXT\n${CONTEXT_NOTE}\n${bulleted(CONTEXT)}`,
  `VOICE\n${bulleted(VOICE)}`,
  `RULES\n${bulleted(RULES)}`,
  `EXAMPLE\nUser:\n${userMessage(EXAMPLE.manifesto, { leads: [], controls: EXAMPLE.controls }, EXAMPLE.candidate)}\nAssistant:\n${EXAMPLE.reply}`,
].join("\n\n")

/** The system prompt for one passage: the shared part, then this passage's lens, place in the argument and length. Without a move the passage was left unplanned. */
export function systemFor({ lens, thesis, move, words }: { lens?: string; thesis?: string; move?: string; words: number }) {
  const passage = [
    lens && `Your lens: ${lens}.`,
    thesis && move !== "thesis" && `The manifesto argues: ${thesis}`,
    move
      ? `Its move is ${move}: ${MOVES[move]}. Make the CLAIM TO MAKE, and only that claim. Open by finishing the manifesto's last sentence, then state the claim and make the OUTLINE's points in order, a sentence or two each. Start no new subject.`
      : "Draw the last claim's consequence, object to it, or test it on an example from your lens, then add a claim the manifesto does not have yet.",
    `Write about ${words} words.`,
    // said again last, where a small model heeds it most
    'No "not" anywhere: state each claim directly, and vary how sentences open.',
  ]
  return `${SYSTEM}\n\nTHIS PASSAGE\n${bulleted(passage.filter((line): line is string => Boolean(line)))}`
}

/**
 * The manifesto comes last: put first, so a steering change would keep Ollama's cached prefix, qwen broke more sentences and ignored strong controls.
 * Only its last `MANIFESTO_WORDS` words are shown.
 */
export function userMessage(prefix: string, steering: Steering, candidate?: Candidate) {
  const starts = [...prefix.matchAll(/\S+/g)].map(({ index }) => index)
  const shown = starts.length > MANIFESTO_WORDS ? `…${prefix.slice(starts[starts.length - MANIFESTO_WORDS])}` : prefix
  return [
    steeringBlocks(steering),
    candidate ? `CLAIM TO MAKE\n${candidate.claim}` : "",
    candidate?.points.length ? `OUTLINE\n${candidate.points.map(({ label, text }) => `${label}: ${text}`).join("\n")}` : "",
    `MANIFESTO SO FAR\n${shown}`,
  ]
    .filter(Boolean)
    .join("\n\n")
}

/** The key phrases and controls, each under its header; empty blocks are left out, header included. */
export function steeringBlocks({ leads, controls }: Steering) {
  const blocks = [
    ["KEY PHRASES", leads.map(({ before, keyword, after }) => `${before}[${keyword}]${after}`)],
    ["CONTROLS", controls.map(controlLine)],
  ] as const
  return blocks
    .filter(([, lines]) => lines.length)
    .map(([header, lines]) => `${header}\n${lines.join("\n")}`)
    .join("\n\n")
}

export function controlLine({ dimension, position, strength }: Control) {
  const options = dimension.kind === "choice" ? ` (options: ${dimension.options.join(", ")})` : ""
  return `${dimension.name}: ${valueOf({ dimension, position })}${options} (${strengthLevelOf(strength)})`
}
