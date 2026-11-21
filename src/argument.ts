import type { Turn } from "./turn-rules.ts"

/**
 * Writes the manifesto's argument into `list`: each turn's claim as its move and claim, numbered from the thesis and marked with its station.
 * `last` keeps the thesis and only that many claims after it. With `isLive`, the last turn is live text, and its claim is marked live.
 */
export function showArgument(list: HTMLOListElement, turns: Turn[], { last = Infinity, isLive = false } = {}) {
  const items = turns.flatMap(({ station, claim }, turn) => {
    if (!claim) return []
    const [, move, text] = /^(\w+): ([\s\S]*)$/.exec(claim) ?? ["", "", claim]
    const item = document.createElement("li")
    item.dataset.station = station
    item.toggleAttribute("data-live", isLive && turn === turns.length - 1)
    item.append(Object.assign(document.createElement("b"), { textContent: move }), ` ${text}`)
    return [item]
  })
  items.forEach((item, i) => (item.value = i + 1))
  list.replaceChildren(...items.filter((_, i) => i === 0 || i >= items.length - last))
  list.hidden = !items.length
}
