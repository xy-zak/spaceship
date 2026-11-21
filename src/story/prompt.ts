export const STORY_MAX_WORDS = 400

export const STORY_SYSTEM_PROMPT = `Continue the story. The user message is its opening, which may stop mid-sentence.

- Output only the words that come next. Do not repeat the opening.
- Your first word directly follows the opening's last word.
- Plain text only. No title, markdown or commentary.
- At most ${STORY_MAX_WORDS} words. End on a complete sentence.

EXAMPLE
User: The alarm went off, but
Assistant:
it was not the one on her phone. Mara lay still and listened.`

export const STORY_REQUEST = {
  system: STORY_SYSTEM_PROMPT,
  temperature: 0.9,
  maxTokens: 2000,
}
