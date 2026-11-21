## HTML

1. Use semantic HTML. If a UI can be determined ahead of time, prefer HTML over JavaScript for rendering.
2. For dialog, use latest HTML standard dialog API. Don't implement your own.

## TypeScript

1. Modern syntax. Organize logic from general to specific with pure function in the end.
2. Use semantic naming and avoid comments unless doing something non-obvious. No section divider comments.

## Styling

1. Use modern CSS, use css variables to ensure style consistency, allow nesting. Use simple grid and flexbox for layout
2. Simple monospace font on the Catppuccin Latte palette in `src/theme.css`: dark text on a light background, one accent per station. Uniform font size and simple consistent spacing.
3. Use system default styles to reduce the use of css.

## Code organization

1. Each page's `main.ts` is a composition: it queries the DOM, creates modules, and wires events between them. Move state machines, algorithms, and async flows into modules.
2. One module per concern, grouped in a folder per feature. Name the file after the concern it owns.
3. Abstract by composition. Expose a factory function that closes over its state and returns a small object, or a plain function. No classes or inheritance.
4. Define a seam only where implementations really vary, as a function or small object type (e.g. `TextSource` with simulated and live versions). Pass it in as an argument.
5. No simple wrappers. An abstraction must own state or logic; if it only renames or forwards to another function, call that function directly.
6. Extract shared code on the second real use, not in anticipation.
7. Model async work as an `AsyncIterable` that accepts an `AbortSignal`, so simulated and real sources are interchangeable and cancellable.

## Workflow

1. Run `npm run format` (Prettier) at the end of your work, before reporting back or committing.
2. The shell is zsh: quote globs (e.g. `--include="*.ts"`) and wrap bash-only syntax in `bash -c`.

## Prototyping with the LLM

1. `.env` holds `CEREBRAS_DEV_API_KEY` for prototyping ideas and engineering prompts from scripts. Never print it, commit it, or ship it to the browser; the app itself calls Ollama through pA's `/ollama` proxy and needs no key.
2. Every call made with that key must track its token usage. Call the API through `chat` in `scripts/cerebras-dev.mjs`, which keeps `token-usage.log` as readable text: the accumulated totals at the top (rewritten on every call) and one appended row per call below (time, script, prompt, cached, completion, reasoning and total tokens). The log is git-ignored.
