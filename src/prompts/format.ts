/** Rules as the prompts list them: one "- " line each, so a rule is added or dropped as one entry of its array. */
export const bulleted = (rules: string[]) => rules.map((rule) => `- ${rule}`).join("\n")
