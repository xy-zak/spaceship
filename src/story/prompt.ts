export function storySystemPrompt(words: number) {
  return `Continue the story. The user message is its opening, which may stop mid-sentence.

- Output only the words that come next. Do not repeat the opening.
- Your first word directly follows the opening's last word.
- Plain text only. No title, markdown or commentary.
- Break the text into paragraphs the way an essay does: a blank line wherever the thought turns, every three to six sentences.
- Write about ${words} words. End on a complete sentence.

EXAMPLE
User: The alarm went off, but
Assistant:
it was not the one on her phone. Mara lay still and listened.`
}

/** Thinking models spend these tokens on reasoning too, so they stay generous; the editor stops the stream once it has the words it asked for. */
export const STORY_REQUEST = {
  temperature: 0.9,
  maxTokens: 2000,
}
