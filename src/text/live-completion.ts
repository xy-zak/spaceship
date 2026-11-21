import { streamCompletion } from "../llm/ollama.ts"
import { STORY_REQUEST, storySystemPrompt } from "../story/prompt.ts"
import { strengthLevelOf, valueOf, type Control } from "./dimension.ts"
import type { Steering, TextSource } from "./text-stream.ts"
import { countWords } from "./words.ts"

function steeredSystemPrompt(words: number) {
  return `Continue the story. The user message may list KEY PHRASES and CONTROLS, then the story so far, which may stop mid-sentence.

- Output only the words that come next. Your first word directly follows the story's last word: if the story stops mid-sentence, finish that sentence first. Never repeat or restart any of the story so far, not even its last word: after "…the door was still" write "locked, and…", never "still locked" or "The door was still locked".
- Key phrases lead what happens next: build the continuation on them, most of all on the [bracketed] words.
- Controls set how the next passage reads. Each is a dimension given only by its name and its poles or options, so infer from the labels what to change in the events, focus or style. A scale gives a position between two poles: at an extreme, exaggerate that pole so a reader notices it within two sentences; midway, balance both. A choice names the option to follow. Each control ends with a strength in parentheses that sets how much it shapes the passage. Strong: it dominates every sentence. Moderate: a clear influence throughout. Slight: show it in one or two touches only, such as a single sentence or image, and otherwise write the passage as the story's own events, the key phrases and the stronger controls would have it; a slight control must never set the overall character of the passage. Strength is separate from the value and replaces the exaggeration rule: exaggerate a pole only at strong. Obey every control from the first sentence to the last, but never write a label itself as words of the story.
- With both, key phrases are the content and controls are the manner: what happens next grows out of the key phrases, whose bracketed words appear in the first two sentences, written in the controlled manner.
- Plain text only. No title, markdown or commentary.
- Break the text into paragraphs the way an essay does: a blank line wherever the thought turns, every three to six sentences.
- Write about ${words} words. End on a complete sentence.

EXAMPLE
User:
KEY PHRASES
not the one on her [phone]

CONTROLS
tension: very strained

STORY SO FAR
Mara had locked the kitchen an hour ago. Now the alarm went off, but it was not the one on her phone. She lay still and
Assistant:
clawed for the phone anyway. Dark screen. The ringing did not stop.`
}

const MAX_ECHO_WORDS = 6

export const liveSource: TextSource = { complete: completeStory }

async function* completeStory(prefix: string, steering: Steering, words: number, signal: AbortSignal) {
  const isSteered = steering.leads.length > 0 || steering.controls.length > 0
  const request = isSteered
    ? { ...STORY_REQUEST, system: steeredSystemPrompt(words), user: steeredUserMessage(prefix, steering) }
    : { ...STORY_REQUEST, system: storySystemPrompt(words), user: prefix }
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

/** Empty blocks are left out, header included. */
function steeredUserMessage(prefix: string, { leads, controls }: Steering) {
  const blocks = [
    ["KEY PHRASES", leads.map(({ before, keyword, after }) => `${before}[${keyword}]${after}`)],
    ["CONTROLS", controls.map(controlLine)],
    ["STORY SO FAR", [prefix]],
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
