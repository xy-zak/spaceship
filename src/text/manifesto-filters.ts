import { EXAMPLE_TEXT } from "../prompts/manifesto.ts"
import { countWords } from "./words.ts"

/** A rewrite of the model's stream, which continues `prefix`, the manifesto so far. */
type Filter = (prefix: string, deltas: AsyncIterable<string>) => AsyncIterable<string>

/** What the writer's stream goes through, in order, each filter taking what the one before left. Drop one to try the writing without it. */
const FILTERS: Filter[] = [
  // a repeat of the manifesto's last words
  withoutEcho,
  // "not X but Y" and ", not X"; prompting alone left them in about half the sentences
  withoutContrasts,
  // sentences the manifesto or the example already has, and restarts of the last one; ends a stream that keeps copying
  withoutCopies,
  // a full stop for the manifesto's open sentence, when the model starts a new one
  withFullStop,
  // paragraphs of three to six sentences
  inParagraphs,
]

export function filtered(prefix: string, deltas: AsyncIterable<string>) {
  return FILTERS.reduce((stream, filter) => filter(prefix, stream), deltas)
}

const MAX_ECHO_WORDS = 6
/** Shorter sentences may repeat, as "We must act." can. */
const MIN_COPY_WORDS = 4
/** A model that keeps copying is looping; ending the stream lets the editor ask again. */
const MAX_COPIES = 3
/** Words that open a sentence, and so start a new one when the manifesto stopped mid-sentence. */
const OPENERS = /^(We|Our|The|A|An|Let|Every|Each|Design|It|Its|This|These|Those|In|If|When|Students|Studios|No|And|But|So)$/
/** Words a sentence can't end on, so a full stop after them would leave it broken anyway. */
const DANGLING =
  /^(must|should|will|can|could|would|is|are|be|the|a|an|of|to|and|or|but|with|for|in|on|at|by|from|that|which|who|its|their|our|every|each|not)$/i
/** The prompt asks for paragraphs of three to six sentences; qwen writes either none or one per sentence. */
const PARAGRAPH_SENTENCES = { min: 3, max: 6 }
/** Where a contrast may start: a mark or verb, then "not" or a word ending in "n't". */
const NOT = /\s*[,;—–]?\s*(?:\b(?:do|does|did|is|are)\s+)?(?:\bnot\b|\b\w+n[’']t\b)/i
/** A "but" followed by one of these opens a clause of its own, which the contrast's first half can't be dropped from. */
const FINITE_VERB = /\b(must|should|will|would|can|could|is|are|was|were|does|do|did|has|have|had)\b/i
const SENTENCE_CLOSE = /[.!?]["”’)]*$/

/** Drops the leading words that repeat the last words of `prefix`, which the model sometimes echoes before it continues. */
async function* withoutEcho(prefix: string, deltas: AsyncIterable<string>) {
  let head: string | undefined = ""
  for await (const delta of deltas) {
    if (head === undefined) {
      yield delta
      continue
    }
    head += delta
    if (countWords(head) <= MAX_ECHO_WORDS) continue
    yield `${separatorOf(head)}${afterEcho(prefix, head)}`
    head = undefined
  }
  const rest = head && afterEcho(prefix, head)
  if (rest) yield `${separatorOf(head!)}${rest}`
}

/**
 * Drops every sentence whose words already run, in order, in the prompt's example, the manifesto `prefix` or earlier in the continuation: a restart of the last sentences, or a slogan said again.
 * A sentence is held back only while its words so far could still be such a copy. A dropped restart that ends the manifesto's unfinished sentence keeps its full stop.
 */
async function* withoutCopies(prefix: string, deltas: AsyncIterable<string>) {
  let isPrefixOpen = !SENTENCE_CLOSE.test(prefix.trimEnd())
  let seen = runOf(`${EXAMPLE_TEXT}\n${prefix}`)
  let sentence = ""
  let shown = 0
  let copies = 0
  const isCopy = (text: string) => shown === 0 && countWords(text) >= MIN_COPY_WORDS && seen.includes(runOf(text))
  for await (const delta of deltas) {
    sentence += delta
    for (let end = endOf(sentence); end; end = endOf(sentence)) {
      const done = sentence.slice(0, end)
      // a lowercase start finishes the manifesto's open sentence, which would dangle without it
      if (!isCopy(done) || (isPrefixOpen && /^\s*\p{Ll}/u.test(done))) {
        yield done.slice(shown)
        seen += `${runOf(done).trim()} `
        isPrefixOpen = false
      } else {
        if (isPrefixOpen && seen.endsWith(runOf(done))) {
          yield done.trim().match(SENTENCE_CLOSE)![0][0]
          isPrefixOpen = false
        }
        if (++copies === MAX_COPIES) return
      }
      sentence = sentence.slice(end)
      shown = 0
    }
    // the last word may still be streaming
    let complete = /\s$/.test(sentence) ? sentence : sentence.replace(/\S+$/, "")
    // a restart of the manifesto's unfinished sentence: the copy goes, the words that finish it stay; once a restart has been dropped, even a short repeat is one
    const restart = shown === 0 && isPrefixOpen ? restartLength(seen, complete, copies ? 1 : MIN_COPY_WORDS) : 0
    if (restart) {
      sentence = sentence.slice(restart)
      complete = complete.slice(restart)
      isPrefixOpen = false
    }
    const isHeld = shown === 0 && (countWords(complete) === 0 || seen.includes(runOf(complete)))
    if (isHeld) continue
    yield sentence.slice(shown)
    shown = sentence.length
  }
  if (!isCopy(sentence)) yield sentence.slice(shown)
}

/** Holds each sentence from its first "not" until it ends, then rewrites its contrasts as plain claims. */
async function* withoutContrasts(_prefix: string, deltas: AsyncIterable<string>) {
  let text = ""
  for await (const delta of deltas) {
    text += delta
    for (let end = endOf(text); end; end = endOf(text)) {
      yield plainClaims(text.slice(0, end))
      text = text.slice(end)
    }
    // from the mark or verb before a "not", or from a last word that may still be followed by one
    const held = Math.min(NOT.exec(text)?.index ?? text.length, /\s*[,;—–]?\s*(?:\b(?:do|does|did|is|are)\s+)?\S*$/i.exec(text)!.index)
    if (held) yield text.slice(0, held)
    text = text.slice(held)
  }
  yield plainClaims(text)
}

/**
 * Rewrites the contrasts that are the commonest tell of machine writing, where the sentence survives without them.
 * A trailing foil goes: "keep the tools open, not locked away" becomes "keep the tools open", and "a crit is not a verdict; it is a rehearsal" becomes "a crit is a rehearsal". So does the first half of "not A but B":
 * "must not be a showroom but a site" becomes "must be a site", keeping A's words up to the one B repeats, and "does not make but learns" becomes "learns";
 * "must not just house makers but stewards" becomes "must house makers and stewards". A "but" that opens its own clause stays.
 */
export function plainClaims(sentence: string) {
  let plain = sentence
  // again until none is left, as one foil may follow another: "not the market, not the grant"
  for (let previous = ""; previous !== plain;) {
    previous = plain
    plain = plain.replace(/(\s*[,;—–]\s*)not\b([^,;.!?—–)\n“"]*)([,;.!?—–)\n]|$)(?!\s*but\b)/i, (foil, _lead, words: string, close: string, at: number) => {
      if (/\bbut\b/i.test(words)) return foil
      // a closing comma goes with the foil, "The studio, not the market, decides.", unless another foil follows; a closing dash stays: "a receipt — not a diploma — a ledger"
      if (close === ",") return /^\s*not\b/i.test(plain.slice(at + foil.length)) ? "," : ""
      return close === "—" || close === "–" ? ` ${close}${/^\s/.test(plain.slice(at + foil.length)) ? "" : " "}` : close
    })
  }
  return plain
    .replace(/\b(is|are) not\b[^;—–.!?]*?\s*[;—–]\s*(?:it|they)\s+/gi, "")
    .replace(/\b(is|are)n[’']t\b[^;—–.!?]*?\s*[;—–,]\s*(?:it|they)[’'](?:s|re)\s+/gi, (_contrast, verb: string) => `${verb} `)
    .replace(
      /\b(?:(do|does|did)\s+)?(not)\s+(?:(just|only|merely|simply)\s+)?([^,;.!?—–:]+?)\s*[,—–]?\s*but\s+(?:also\s+)?([^.!?—–;:]+?)(?=\s*,\s*(?:and|or|so|yet)\b|[.!?—–;:]|$)/gi,
      (contrast, aux: string | undefined, not: string, just: string | undefined, a: string, b: string) => {
        if (FINITE_VERB.test(b) || (just && aux)) return contrast
        const aWords = a.split(/\s+/)
        const anchor = aWords.findIndex((word) => word.toLowerCase() === b.split(/\s+/)[0].toLowerCase())
        const kept = anchor >= 0 ? aWords.slice(0, anchor) : aWords[0] === "be" ? ["be"] : []
        // "not just A but B" adds B to A; "does not end here but there" keeps its "does", which "end" needs, and "does not copy but learns" drops it
        const claim = just ? `${a} and ${b}` : [...(aux && kept.length ? [aux] : []), ...kept, b].join(" ")
        return not === "Not" ? claim[0].toUpperCase() + claim.slice(1) : claim
      },
    )
}

/** The model sometimes starts a new sentence where the manifesto stopped mid-sentence; a full stop ends the manifesto's. */
async function* withFullStop(prefix: string, deltas: AsyncIterable<string>) {
  const last = prefix.trimEnd().match(/\S+$/)?.[0] ?? ""
  let head: string | undefined = /[\p{L}\p{N}]$/u.test(last) && !DANGLING.test(last) ? "" : undefined
  for await (const delta of deltas) {
    if (head === undefined) {
      yield delta
      continue
    }
    head += delta
    const first = /^\s*(\S+)\s/.exec(head)?.[1]
    if (!first) continue
    yield `${OPENERS.test(first) ? "." : ""}${head}`
    head = undefined
  }
  if (head) yield head
}

/** Keeps a paragraph break only after `PARAGRAPH_SENTENCES.min` sentences, counting those of the manifesto's last paragraph, and breaks one that reaches `max`. */
async function* inParagraphs(prefix: string, deltas: AsyncIterable<string>) {
  let sentences = (
    prefix
      .split("\n")
      .at(-1)!
      .match(/[.!?]["”’)]*(\s|$)/g) ?? []
  ).length
  // trailing space, which the next delta may turn into a paragraph break
  let space = ""
  let isAfterSentence = false
  for await (const delta of deltas) {
    const text = space + delta
    const end = text.search(/\s*$/)
    space = text.slice(end)
    let out = ""
    for (const part of text.slice(0, end).split(/(\s+)/)) {
      if (!part) continue
      if (/\S/.test(part)) {
        out += part
        isAfterSentence = /[.!?]["”’)]*$/.test(part)
        if (isAfterSentence) sentences++
        continue
      }
      const isBreak = part.includes("\n") ? sentences >= PARAGRAPH_SENTENCES.min : sentences >= PARAGRAPH_SENTENCES.max && isAfterSentence
      out += isBreak ? "\n\n" : " "
      if (isBreak) sentences = 0
    }
    if (out) yield out
  }
}

/** How many characters of `text` copy the last words of `seen`, at least `minWords` of them; 0 when it doesn't open with such a copy. */
function restartLength(seen: string, text: string, minWords: number) {
  const words = [...text.matchAll(/\S+/g)].filter(([word]) => bareWord(word))
  for (let count = words.length; count >= minWords; count--) {
    const last = words[count - 1]
    if (seen.endsWith(runOf(text.slice(0, last.index + last[0].length)))) return last.index + last[0].length
  }
  return 0
}

/** A continuation that opens with a line break starts a new paragraph. */
function separatorOf(head: string) {
  return /^\s*\n/.test(head) ? "\n\n" : " "
}

function afterEcho(prefix: string, head: string) {
  const start = head.trimStart()
  // after a finished sentence, its last words opening the next one are new: "…of the studio. The studio must…"
  if (SENTENCE_CLOSE.test(prefix.trimEnd())) return start
  const tail = (prefix.match(/\S+/g) ?? []).slice(-MAX_ECHO_WORDS).map(bareWord)
  const words = [...start.matchAll(/\S+/g)]
  for (let count = Math.min(tail.length, words.length); count > 0; count--) {
    const isEcho = tail.slice(-count).every((word, i) => word !== "" && word === bareWord(words[i][0]))
    if (isEcho) return start.slice(words[count - 1].index + words[count - 1][0].length).trimStart()
  }
  return start
}

/** Where the first sentence of `text` ends, its closing mark included; 0 while none has. */
function endOf(text: string) {
  const match = /[.!?]["”’)]*(?=\s)/.exec(text)
  return match ? match.index + match[0].length : 0
}

/** The text's bare words between spaces, so a run is found by `includes` on whole words only; "a" and "the" match, as a copy often swaps them. */
function runOf(text: string) {
  return ` ${(text.replace(/[—–]/g, " ").match(/\S+/g) ?? [])
    .map(bareWord)
    .filter(Boolean)
    .map((word) => (/^(a|an|the)$/.test(word) ? "the" : word))
    .join(" ")} `
}

function bareWord(word: string) {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")
}
