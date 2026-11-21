import { setTimeout as sleep } from "node:timers/promises"

const RETRY_MS = 1000

/** `/api/events` as `{ type, data }`, reconnecting after 1 s the way EventSource does, with an `offline` event for each drop. */
export async function* turnEvents(url, signal) {
  while (!signal?.aborted) {
    let reason
    try {
      const response = await fetch(url, { signal })
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
      for await (const { event, data } of framesOf(response.body)) yield { type: event, data: data ? JSON.parse(data) : undefined }
      reason = "stream ended"
    } catch (error) {
      if (signal?.aborted) return
      reason = error.cause?.code ?? error.message
    }
    yield { type: "offline", reason }
    await sleep(RETRY_MS, undefined, { signal }).catch(() => {})
  }
}

/** Frames of a text/event-stream body as `{ event, data }`. Like EventSource, frames without a data line are skipped. */
export async function* framesOf(body) {
  let buffer = ""
  for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk.replaceAll("\r\n", "\n")
    const frames = buffer.split("\n\n")
    buffer = frames.pop()
    for (const frame of frames) {
      const lines = frame.split("\n")
      const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, ""))
      if (!data.length) continue
      const event = lines.find((line) => line.startsWith("event:"))?.slice(6)
      yield { event: event?.trim() || "message", data: data.join("\n") }
    }
  }
}
