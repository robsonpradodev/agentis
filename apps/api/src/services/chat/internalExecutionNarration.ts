/** Runtime/operator diagnostics that must never be delivered or learned as customer copy. */
export function containsInternalExecutionNarration(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  return /\bexecution[- ]format\s+(?:problem|error)\b/iu.test(value)
    || /\bprompt is too long\b/iu.test(value)
    || /\b(?:claude code|codex|hermes|cursor) ended before finishing\b/iu.test(value)
    || /\bcredential context\s*:/iu.test(value)
    || /\bretry(?:ing)?\s+(?:it\s+)?through\s+the\s+correct\s+channel\b/iu.test(value)
    || /\bi stopped because i was repeating myself\b/iu.test(value)
    || /\bi stopped because (?:the tool loop was going in circles|execution was not moving forward)\b/iu.test(value)
    || /\bagentis stopped after\b[\s\S]*\btool\b/iu.test(value)
    || /\bi (?:worked through several steps but reached the per-turn action limit|ran one or more tools this turn but the runtime didn[’']t return a closing answer|worked through that but didn[’']t manage to put my answer into words)\b/iu.test(value)
    || /\bthe runtime completed without returning an answer\b/iu.test(value)
    || /\b(?:the\s+)?(?:task|mission|goal)\s+(?:remains?|is|was|has been)\s+(?:saved|running|paused|blocked|failed|cancelled|canceled|accomplished)\b/iu.test(value)
    || /\b(?:agent|model|hermes|runtime)\s+(?:produced no observable output|timed out|appears stuck|went quiet)\b/iu.test(value)
    || /\b(?:unconsumed tool protocol|tool[_ -]?call|adapter\.chat|finishreason|runtime error)\b/iu.test(value)
    || /\bagentis\s+(?:settings|runtime|workflow|mission|task|goal)\b/iu.test(value)
    || /\bwork failed for\s+\d/iu.test(value)
    || /_?paused\s+[—-]\s+hermes\b[\s\S]*\bask me to continue\b/iu.test(value);
}

/** Host-authored reset prompt substituted for a slash command, never customer knowledge. */
export function isSyntheticCustomerResetPrompt(text: string): boolean {
  return /^Start a fresh customer-service conversation now\.\s+Greet the person briefly[\s\S]*Do not mention this reset instruction/iu.test(text.trim());
}
