import { streamCompletion } from "../llm/ollama.ts"
import { LENS_THEMES, LENSES, type Station } from "../stations.ts"
import { strengthLevelOf, valueOf, type Control } from "./dimension.ts"
import type { Steering, TextSource } from "./text-stream.ts"
import { countWords } from "./words.ts"

/** The part every station shares comes first, so Ollama can reuse its cached prefix. */
const SYSTEM_PROMPT = `Continue the manifesto on design education. The user message may list KEY PHRASES and CONTROLS, then the MANIFESTO SO FAR, which may stop mid-sentence.

CONTEXT
The manifesto's setting is Design Academy Eindhoven (DAE). Its Institutional Plan 2025-2028 is background, never to be quoted: the manifesto may take up, sharpen or reject its positions. Use the context sparingly: most passages need none of it, and the manifesto names a place at most once.
- A small, independent, international academy, more than 75 years old. Bachelor students work in nine studios, each a different approach to research and making, beside the fundamentals. The master is becoming research labs; an associate degree in immersive design starts in 2027.
- In 2028 it moves to a new campus in Eindhoven, with housing for first-years, in the Brainport region of technology, industry and government partners.
- It faces the climate crisis, AI as a design tool, growing inequality, and politics that question international institutions and the funding of progressive ideas.
- The plan holds that design is a social and cultural practice, not merely a tool for innovation; that thinking and making belong together; that many voices and ways of knowing beat a single canon; that design must look beyond the market; that the right questions come before solutions.

VOICE
- A manifesto: claims a reader could argue with, in the present tense, mostly short, with "must" and "we". Vary their shape: a demand, a definition, a question, a list, a scene from a studio. Use "not … but …" at most once per passage.
- The language of design education, as the plan speaks it: studio, lab, brief, crit, material, praxis, discourse. Prefer a concrete studio, brief, material or person to an abstraction, and let no word or image become a refrain.
- The plan's moves: pairs ("thinking and making"), spans ("from a single studio to the planet"), questions before answers. Use its moves, never its sentences.

RULES
- Output only the words that come next in the manifesto. Your first word directly follows the manifesto's last word: if it stops mid-sentence, finish that sentence first. Never repeat or restart any of the manifesto so far, not even its last word: after "…every brief should" write "end with a question, …", never "should end" or "Every brief should end".
- Move the argument on: add a claim, example, objection or consequence the manifesto does not have yet. Never copy a sentence, or any run of four words, from the manifesto so far, and never return to a place, image or example it has already used.
- Key phrases lead what comes next: build the continuation on them, most of all on the [bracketed] words.
- Controls set how the next passage reads. Each is a dimension given only by its name and its poles or options, so infer from the labels what to change in the claims, focus or style. A scale gives a position between two poles: at an extreme, exaggerate that pole so a reader notices it within two sentences; midway, balance both. A choice names the option to follow. Each control ends with a strength in parentheses that sets how much it shapes the passage. Strong: it dominates every sentence. Moderate: a clear influence throughout. Slight: show it in one or two touches only, such as a single sentence or image, and otherwise write the passage as the manifesto's own argument, the key phrases and the stronger controls would have it; a slight control must never set the overall character of the passage. Strength is separate from the value and replaces the exaggeration rule: exaggerate a pole only at strong. Obey every control from the first sentence to the last, but never write a label itself as words of the manifesto.
- With both, key phrases are the content and controls are the manner: what comes next grows out of the key phrases, whose bracketed words appear in the first two sentences, written in the controlled manner.
- Plain text only. No title, markdown or commentary.
- Break the text into paragraphs the way an essay does: a blank line wherever the thought turns, every three to six sentences.
- End on a complete sentence.

EXAMPLE
User:
KEY PHRASES
the work's best [mistake]

CONTROLS
stance: very radical (strong)

MANIFESTO SO FAR
Every crit starts with the work's best mistake. A brief should
Assistant:
end with a question the tutor cannot answer either. Abolish the final grade, mark the mistakes instead, and keep the argument going until the work changes.`

/** Each station's editor gets the source for its own lens; without a station the prompt has none. */
export function liveSourceFor(station?: Station): TextSource {
  const lens = station && LENSES[station] ? `\n- Lens: ${LENSES[station]}. Draw on ${LENS_THEMES[station]}.` : ""
  return {
    complete: (prefix, steering, words, signal) =>
      completeManifesto(`${SYSTEM_PROMPT}\n\nTHIS PASSAGE${lens}\n- Write about ${words} words.`, prefix, steering, signal),
  }
}

/** Thinking models spend these tokens on reasoning too, so they stay generous; the editor stops the stream once it has the words it asked for. */
const REQUEST = { temperature: 0.9, maxTokens: 2000 }

const MAX_ECHO_WORDS = 6

async function* completeManifesto(system: string, prefix: string, steering: Steering, signal: AbortSignal) {
  const request = { ...REQUEST, system, user: userMessage(prefix, steering) }
  let head: string | undefined = ""
  for await (const delta of streamCompletion({ ...request, signal })) {
    if (head === undefined) {
      yield delta
      continue
    }
    head += delta
    if (countWords(head) <= MAX_ECHO_WORDS) continue
    yield `${separatorOf(head)}${withoutEcho(prefix, head)}`
    head = undefined
  }
  const rest = head && withoutEcho(prefix, head)
  if (rest) yield `${separatorOf(head!)}${rest}`
}

/** A continuation that opens with a line break starts a new paragraph. */
function separatorOf(head: string) {
  return /^\s*\n/.test(head) ? "\n\n" : " "
}

/** Drops the leading words of `head` that repeat the last words of `prefix`, which the model sometimes echoes before it continues. */
function withoutEcho(prefix: string, head: string) {
  const start = head.trimStart()
  const tail = (prefix.match(/\S+/g) ?? []).slice(-MAX_ECHO_WORDS).map(bareWord)
  const words = [...start.matchAll(/\S+/g)]
  for (let count = Math.min(tail.length, words.length); count > 0; count--) {
    const isEcho = tail.slice(-count).every((word, i) => word !== "" && word === bareWord(words[i][0]))
    if (isEcho) return start.slice(words[count - 1].index + words[count - 1][0].length).trimStart()
  }
  return start
}

function bareWord(word: string) {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")
}

/** The manifesto comes last: put first, so a steering change would keep Ollama's cached prefix, qwen broke more sentences and ignored strong controls. Empty blocks are left out, header included. */
function userMessage(prefix: string, { leads, controls }: Steering) {
  const blocks = [
    ["KEY PHRASES", leads.map(({ before, keyword, after }) => `${before}[${keyword}]${after}`)],
    ["CONTROLS", controls.map(controlLine)],
    ["MANIFESTO SO FAR", [prefix]],
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
