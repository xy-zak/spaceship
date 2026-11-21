export function countWords(text: string) {
  return text.match(/\S+/g)?.length ?? 0
}

/** The first `count` words with the whitespace before them, or the whole text when it has fewer. */
export function firstWords(text: string, count: number) {
  return text.match(new RegExp(`^(?:\\s*\\S+){0,${count}}`))![0]
}
