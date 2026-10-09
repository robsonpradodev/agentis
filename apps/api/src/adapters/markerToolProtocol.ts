/**
 * markerToolProtocol — tool-calling for CLI runtimes that have no native
 * function-calling channel (Codex CLI, Claude Code CLI).
 *
 * These adapters spawn a child process in `--json` mode and the model is
 * instructed (see `buildMarkerToolPrompt`) to emit tool calls as a marker
 * embedded in its assistant text:
 *
 *   AGENTIS_TOOL_CALL {"name":"agentis.build_workflow","arguments":{...}}
 *   <agentis_tool_call>{"name":"...","arguments":{...}}</agentis_tool_call>
 *
 * This module is the single source of truth for parsing those markers back into
 * structured `ChatToolCall`s and for keeping environment noise out of the
 * operator-visible transcript.
 *
 * Why a dedicated module: the previous per-adapter implementation anchored the
 * marker to the start/end of a line (`/^AGENTIS_TOOL_CALL\s+({.*})\s*$/m`) and,
 * in the `catch` branch, appended every non-JSON stdout line straight into the
 * transcript. On Windows the Codex sandbox prints `taskkill` output
 * ("ÊXITO: o processo com PID … foi finalizado") on the SAME line as the
 * marker. That broke the `\s*$` anchor, so the tool call was never parsed,
 * never executed, never stripped — the raw marker + PID spam was shown to the
 * operator and the platform did nothing. This module fixes both halves:
 *   1. brace-balanced extraction tolerant of trailing prose/junk, and
 *   2. a locale-agnostic noise filter for process-kill chatter.
 */

import type { ToolDefinition } from '@agentis/core';

export interface MarkerToolCall {
  name: string;
  args: unknown;
}

export interface MarkerExtractionResult {
  /** Tool calls discovered in the text, de-duplicated by name+args. */
  calls: MarkerToolCall[];
  /** The operator-visible text with every marker removed. */
  cleaned: string;
}

const MARKER_KEYWORD = 'AGENTIS_TOOL_CALL';

/**
 * Extract every Agentis tool-call marker embedded in CLI output.
 *
 * Robust to: trailing prose after the JSON, junk concatenated on the same line,
 * multi-line JSON, nested braces, and braces inside JSON string values. Markers
 * that don't parse are left in the cleaned text verbatim so nothing is silently
 * swallowed.
 */
export function extractMarkerToolCalls(input: string, tools: ToolDefinition[] = []): MarkerExtractionResult {
  const calls: MarkerToolCall[] = [];
  const seen = new Set<string>();
  const record = (payload: MarkerToolCall | null): boolean => {
    if (!payload) return false;
    payload = normalizeToolAlias(payload);
    const key = `${payload.name}:${stableJson(payload.args)}`;
    if (!seen.has(key)) {
      seen.add(key);
      calls.push(payload);
    }
    return true;
  };

  // 0) Hermes native transcript form. Some Hermes models do not follow the
  // Agentis marker instruction verbatim and instead emit their native special
  // tokens plus one `tool.name {arguments}` line per call:
  //
  //   <tool_call>
  //   </｜tool▁calls_begin｜>
  //   agentis.channel.send {"to":"...","body":"..."}
  //   <｜tool▁calls_end｜>
  //   </｜tool_calls｜>
  //
  // This is still an executable tool boundary, never answer prose. Normalize it
  // before the XML pass so the unmatched outer `<tool_call>` cannot leak into
  // the operator transcript or falsely complete an action task.
  let withoutHermes = extractHermesNativeBlocks(input, record);

  // 0b) Hermes nested XML form. Some model/provider combinations emit one
  // named XML element per tool with an <args> child and omit the closing outer
  // <tool_call> wrapper entirely:
  //
  //   <tool_call>
  //   <agentis.channel.send><args><to>...</to></args></agentis.channel.send>
  //
  // This is executable protocol, not operator prose. Parse the named calls
  // independently so an unmatched wrapper can never leak into WhatsApp/chat.
  withoutHermes = extractHermesNestedXmlCalls(withoutHermes, record);

  // 1) XML-style fenced form. Hermes historically emitted <tool_call>, so
  // normalize both spellings at the adapter boundary.
  let withoutXml = withoutHermes.replace(
    /<(?:agentis_)?tool_call>\s*([\s\S]*?)\s*<\/(?:agentis_)?tool_call>/gi,
    (whole, body: string) => (record(parseMarkerPayload(body)) ? '' : whole),
  );

  // 1b) Legacy CLI transcript form: REQUESTED TOOLS: [{name, arguments}].
  withoutXml = withoutXml.replace(/REQUESTED TOOLS:\s*(\[[\s\S]*?\])(?=\n[A-Z][A-Z ]+:|$)/gi, (whole, body: string) => {
    try {
      const payloads = JSON.parse(body) as unknown;
      if (!Array.isArray(payloads)) return whole;
      let parsedAny = false;
      for (const payload of payloads) parsedAny = record(parseMarkerPayload(JSON.stringify(payload))) || parsedAny;
      return parsedAny ? '' : whole;
    } catch { return whole; }
  });

  // 2) Keyword form with brace-balanced JSON extraction.
  let cleaned = '';
  let cursor = 0;
  while (cursor < withoutXml.length) {
    const markerIndex = withoutXml.indexOf(MARKER_KEYWORD, cursor);
    if (markerIndex === -1) {
      cleaned += withoutXml.slice(cursor);
      break;
    }
    cleaned += withoutXml.slice(cursor, markerIndex);

    // Skip whitespace / a colon between the keyword and the opening brace.
    let braceIndex = markerIndex + MARKER_KEYWORD.length;
    while (braceIndex < withoutXml.length && withoutXml[braceIndex] !== '{' && /[\s:]/.test(withoutXml[braceIndex]!)) {
      braceIndex += 1;
    }
    if (withoutXml[braceIndex] !== '{') {
      // Not a real marker (keyword mentioned in prose) — keep it as text.
      cleaned += MARKER_KEYWORD;
      cursor = markerIndex + MARKER_KEYWORD.length;
      continue;
    }

    const end = matchBalancedBrace(withoutXml, braceIndex);
    if (end === -1) {
      // Unterminated JSON — keep the remainder as text and stop.
      cleaned += withoutXml.slice(markerIndex);
      break;
    }
    const parsed = parseMarkerPayload(withoutXml.slice(braceIndex, end));
    if (!record(parsed)) {
      // Failed to parse — preserve the original span so it isn't lost.
      cleaned += withoutXml.slice(markerIndex, end);
    }
    cursor = end;
  }

  cleaned = cleaned.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  // Some fallback models emit a plain function envelope with no marker at all:
  //   {"name":"image.generate","arguments":{...}}
  // When the entire assistant response is that envelope it is executable
  // protocol, never human-facing prose. Normalize it here so the caller loop can
  // execute it (or return a schema error for bounded repair) instead of sending
  // raw JSON to WhatsApp/Telegram.
  if (looksLikeBareToolEnvelope(cleaned) && record(parseMarkerPayload(cleaned))) cleaned = '';

  // Some fallback runtimes emit only the argument object after the surrounding
  // prompt has already established one tool. Bind it only when the offered JSON
  // schemas identify exactly one compatible tool; ambiguity remains visible for
  // one model repair round instead of guessing a side effect.
  if (calls.length === 0 && looksLikeBareArguments(cleaned)) {
    const bound = bindBareArguments(cleaned, tools);
    if (bound && record(bound)) cleaned = '';
  }

  return { calls, cleaned };
}

function looksLikeBareArguments(value: string): boolean {
  return /^\s*\{[\s\S]*\}\s*$/.test(value) && !looksLikeBareToolEnvelope(value);
}

function bindBareArguments(value: string, tools: ToolDefinition[]): MarkerToolCall | null {
  let args: Record<string, unknown>;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    args = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const keys = Object.keys(args);
  if (keys.length === 0) return null;
  const matches = tools.filter((tool) => {
    const schema = tool.parameters;
    const properties = schema?.properties ?? {};
    const required = schema?.required ?? [];
    return required.every((key) => Object.hasOwn(args, key))
      && keys.every((key) => Object.hasOwn(properties, key));
  });
  if (matches.length !== 1) return null;
  return { name: matches[0]!.name, args };
}

function looksLikeBareToolEnvelope(value: string): boolean {
  return /^\s*\{[\s\S]*\}\s*$/.test(value)
    && /"(?:name|toolName|tool)"\s*:/.test(value)
    && /"(?:arguments|args|input)"\s*:/.test(value);
}

function normalizeToolAlias(payload: MarkerToolCall): MarkerToolCall {
  const aliases: Record<string, string> = {
    'image.generate': 'agentis.media.generate',
    'media.generate': 'agentis.media.generate',
    'assets.list': 'agentis.assets.list',
    'assets.search': 'agentis.assets.search',
    'assets.read': 'agentis.assets.read',
    'channel.send': 'agentis.channel.send',
  };
  const name = aliases[payload.name] ?? payload.name;
  if (payload.name === 'image.generate' && payload.args && typeof payload.args === 'object' && !Array.isArray(payload.args)) {
    return { name, args: { modality: 'image', ...(payload.args as Record<string, unknown>) } };
  }
  return { name, args: payload.args };
}

function extractHermesNestedXmlCalls(
  input: string,
  record: (payload: MarkerToolCall | null) => boolean,
): string {
  let parsedAny = false;
  const withoutCalls = input.replace(
    /<((?:agentis\.)[A-Za-z][\w.-]*)>\s*<args>([\s\S]*?)<\/args>\s*<\/\1>/gi,
    (whole, name: string, argsBody: string) => {
      const args = parseFlatXmlArgs(argsBody);
      if (!args || !record({ name, args })) return whole;
      parsedAny = true;
      return '';
    },
  );
  if (!parsedAny) return input;
  return withoutCalls.replace(/<tool_call>\s*/gi, '').replace(/\s*<\/tool_call>/gi, '');
}

function parseFlatXmlArgs(input: string): Record<string, unknown> | null {
  const args: Record<string, unknown> = {};
  const field = /<([A-Za-z][\w.-]*)>([\s\S]*?)<\/\1>/g;
  let cursor = 0;
  let found = false;
  for (let match = field.exec(input); match; match = field.exec(input)) {
    if (input.slice(cursor, match.index).trim()) return null;
    const raw = decodeXmlEntities(match[2]!.trim());
    args[match[1]!] = xmlScalar(raw);
    cursor = field.lastIndex;
    found = true;
  }
  if (!found || input.slice(cursor).trim()) return null;
  return args;
}

function xmlScalar(value: string): unknown {
  if (/^(?:true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) return Number(value);
  return value;
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_whole, entity: string) => ({
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  })[entity] ?? _whole);
}

/** Remove Hermes special-token blocks and record their line-oriented calls. */
function extractHermesNativeBlocks(
  input: string,
  record: (payload: MarkerToolCall | null) => boolean,
): string {
  const begin = /<\/?[|｜]tool(?:▁|_|\s)+calls(?:▁|_|\s)+begin[|｜]>/gi;
  const end = /<\/?[|｜]tool(?:▁|_|\s)+calls(?:▁|_|\s)+end[|｜]>/gi;
  let output = '';
  let cursor = 0;
  while (cursor < input.length) {
    begin.lastIndex = cursor;
    const start = begin.exec(input);
    if (!start) {
      output += input.slice(cursor);
      break;
    }
    end.lastIndex = begin.lastIndex;
    const finish = end.exec(input);
    if (!finish) {
      output += input.slice(cursor);
      break;
    }
    let prefix = input.slice(cursor, start.index);
    // Hermes often leaves an unmatched wrapper immediately before the native
    // begin token. It is protocol syntax too, so remove it with the block.
    prefix = prefix.replace(/<(?:agentis_)?tool_call>\s*$/i, '');
    output += prefix;
    const body = input.slice(begin.lastIndex, finish.index);
    let parsedAny = false;
    for (const call of parseHermesNamedCalls(body)) {
      parsedAny = record(call) || parsedAny;
    }
    if (!parsedAny) {
      // Preserve an unrecognized block for diagnosis; the completion gate will
      // reject it as unconsumed protocol instead of silently swallowing it.
      output += input.slice(start.index, end.lastIndex);
    }
    cursor = end.lastIndex;
    // Consume Hermes' optional closing wrapper after the special-token block.
    const closing = input.slice(cursor).match(/^\s*<\/?[|｜]tool(?:▁|_|\s)*calls[|｜]>\s*/i);
    if (closing) cursor += closing[0].length;
  }
  return output;
}

/** Parse `agentis.tool.name { ... }` calls with brace balancing. */
function parseHermesNamedCalls(body: string): MarkerToolCall[] {
  const calls: MarkerToolCall[] = [];
  const namePattern = /(?:^|\n)\s*([A-Za-z][\w.-]*)\s*(?=\{)/g;
  for (let match = namePattern.exec(body); match; match = namePattern.exec(body)) {
    const name = match[1]!;
    const brace = body.indexOf('{', match.index + match[0].length - 1);
    if (brace < 0) continue;
    const end = matchBalancedBrace(body, brace);
    if (end < 0) continue;
    try {
      calls.push({ name, args: JSON.parse(body.slice(brace, end)) as unknown });
      namePattern.lastIndex = end;
    } catch {
      // Leave malformed native protocol in the cleaned text by returning no
      // parsed calls for it; the caller retains the original block.
    }
  }
  return calls;
}

/**
 * True for stdout lines that are environment noise rather than model output.
 *
 * Primarily Windows `taskkill /F /T` output emitted when the Codex sandbox
 * tears down its child process tree. Matched in a locale-agnostic way: a line
 * that references a PID together with a termination verb in any of the locales
 * we've observed. These lines must never reach the operator.
 */
export function isProcessNoiseLine(line: string): boolean {
  const value = line.trim();
  if (!value) return true;
  const mentionsPid = /\bPID\b/i.test(value) || /processo|process|proceso|prozess|processus/i.test(value);
  const mentionsTermination = /(finaliz|terminat|terminé|encerrad|beend|chiuso|завершён|завершен|killed|has been|foi finaliz)/i.test(value);
  if (mentionsPid && mentionsTermination) return true;
  // Bare success/error banners that only carry a PID payload.
  if (/^(ÊXITO|EXITO|SUCCESS|ERRO|ERROR|INFO|AVISO|WARN(ING)?)\s*[:!]/i.test(value) && /\bPID\b/i.test(value)) return true;
  // `taskkill`'s FAILURE banner — "process already gone" — fires whenever the
  // kill signal loses a benign race against a child process that already
  // exited on its own. Unlike the success banner, it names the numeric id
  // directly ("ERRO: o processo \"12172\" não foi encontrado.") without the
  // word PID, so it needs its own locale-agnostic "not found" match.
  const mentionsNotFound = /(not (?:be )?found|não foi encontrado|no (?:fue|ha sido) encontrado|nicht gefunden|non trovato|introuvable|не найден)/i.test(value);
  if (mentionsPid && mentionsNotFound) return true;
  return false;
}

/**
 * Strip process-kill noise from a free-form blob (used as the last-resort
 * fallback when a CLI produced no JSON content at all).
 */
export function stripProcessNoise(text: string): string {
  return text
    .split('\n')
    .filter((line) => !isProcessNoiseLine(line))
    .join('\n')
    .trim();
}

/**
 * Shared system-prompt block instructing a CLI runtime how to emit tool calls.
 * Kept here so every marker-protocol adapter (Codex, Claude Code, Hermes) stays
 * in lockstep with the parser above.
 *
 * IMPORTANT — stay TRUTHFUL about the environment. These harnesses run locally on
 * the operator's machine and DO have their own tools and filesystem. An earlier
 * version asserted "there is NO local filesystem", which (a) is false and (b)
 * directly contradicts what the runtime can plainly see — a safety-aligned model
 * then treats the whole block as a prompt-injection attempt and refuses it.
 * Agentis is a neutral platform: it offers its platform tools as an ADDITIONAL
 * capability and lets the agent be whatever the operator configured; it does not
 * lie about, or fight, the runtime's native environment.
 */
export function buildMarkerToolPrompt(
  tools: ToolDefinition[],
  opts?: { compact?: boolean; nativeTools?: boolean },
): string {
  // Compact rendering: one line per tool (name + param keys + description), no
  // pretty-printed JSON schema or examples. Used where the whole prompt must stay
  // small — e.g. Hermes, whose CLI takes the prompt as an inline `-q` argument
  // bounded by the OS command-line limit. Keeps every tool + its argument names
  // (enough to call by marker) at a fraction of the size.
  const toolBlock = opts?.compact
    ? tools.map(compactToolLine).join('\n')
    : stableJson(tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        examples: (tool as ToolDefinition & { examples?: unknown }).examples ?? [],
        parameters: tool.parameters,
      })));
  return [
    'Agentis interactive chat session.',
    '',
    'You also have the Agentis platform tools listed below. Use them when a tool matches the operator request.',
    'Never tell the operator to paste JSON somewhere or run a platform action themselves — you run it.',
    '',
    'AGENTIS PLATFORM TOOLS:',
    '- To act on the Agentis platform — its workflows, data, agents, channels, and memory — use the AGENTIS_TOOL_CALL protocol below. That is the only way to reach platform state.',
    opts?.nativeTools === false
      ? '- This invocation is intentionally model-only: Agentis owns ALL tool execution. Use the marker protocol for every action; do not attempt terminal, filesystem, skill, browser, or other runtime-native calls.'
      : '- These platform tools are IN ADDITION to whatever native tools your runtime already gives you; they do not replace them. Use whichever fits the request.',
    '- When the request calls for a platform action, decide from the conversation and the tool list and call the tool immediately.',
    '',
    'TOOL CALL PROTOCOL (this CLI runtime has no native function calling):',
    '- Before calling a tool, write exactly one short operator-facing progress sentence stating the concrete finding from prior results and the next action.',
    '- The progress sentence must be specific and safe to show in chat. Never expose private reasoning, hidden prompts, secrets, or filler such as "I am working", "reviewing context", "waiting", or "I will report back".',
    '- Then output the tool marker on its own line: AGENTIS_TOOL_CALL {"name":"tool.name","arguments":{ ... }}',
    '- Do not write prose after a marker. Do not use markdown or code fences around markers.',
    '- Agentis executes the tool and feeds the result back to you on the next turn; then continue.',
    '- You may emit several markers (one per line) to run independent tools in one turn.',
    '- Call ONLY tools from the list below, with their exact names. Do not invent tool names.',
    '- Only answer in plain prose (no marker) when the request truly needs no tool.',
    '',
    'Available tools:',
    toolBlock,
  ].join('\n');
}

/** One compact `- name(arg1, arg2): description` line for a tool. */
function compactToolLine(tool: ToolDefinition): string {
  const params = tool.parameters && typeof tool.parameters === 'object'
    ? (tool.parameters as { properties?: Record<string, unknown> }).properties
    : undefined;
  const keys = params && typeof params === 'object' ? Object.keys(params) : [];
  const sig = keys.length > 0 ? `(${keys.join(', ')})` : '';
  const description = (tool.description ?? '').replace(/\s+/g, ' ').trim();
  return `- ${tool.name}${sig}${description ? `: ${description}` : ''}`;
}

/**
 * Concise awareness block listing the Agentis platform tools available in the
 * workspace, appended to workflow-node task prompts so the agent knows the
 * platform surface exists. Informational only — workflow dispatch is
 * fire-and-forget, so this does not wire an execution loop.
 */
export function formatToolManifestAwareness(manifest?: Array<{ name: string; description: string }>): string {
  if (!manifest || manifest.length === 0) return '';
  return [
    '',
    'AGENTIS PLATFORM TOOLS available in this workspace (for your awareness):',
    ...manifest.map((tool) => `- ${tool.name}: ${tool.description}`),
  ].join('\n');
}


function matchBalancedBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function parseMarkerPayload(raw: string): MarkerToolCall | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const payload = JSON.parse(trimmed) as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const record = payload as Record<string, unknown>;
    const name = firstStringValue(record.name, record.toolName, record.tool);
    if (!name) return null;
    return { name, args: record.arguments ?? record.args ?? record.input ?? {} };
  } catch {
    return null;
  }
}

function firstStringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[unserializable]';
  }
}
