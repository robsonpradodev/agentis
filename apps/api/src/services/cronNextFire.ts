/**
 * nextCronFire — next occurrence of a standard 5-field cron expression.
 *
 * Supports `* , - /` (lists, ranges, steps) per field, names for months/days
 * (jan-dec, sun-sat), and the vixie-cron day rule: when BOTH day-of-month and
 * day-of-week are restricted, a date matches if EITHER matches. Evaluated in
 * UTC (App-binding schedules are workspace-server time; timezones ride the
 * graph-trigger path, which owns richer scheduling).
 *
 * Why not node-cron: it can *run* schedules but cannot answer "when is the next
 * fire?" — which the AppOrchestrator sweep (and the OrchestrationPanel's
 * "next run" column) needs. Scan is minute-resolution, capped at 5 years-ish
 * (400 days) — far beyond any real schedule; invalid/never-matching
 * expressions return null instead of looping.
 */

interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /** True when the field was `*` (needed for the vixie day-OR rule). */
  domAny: boolean;
  dowAny: boolean;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const DAY_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function resolveToken(token: string, names: Record<string, number> | null): number {
  const lower = token.toLowerCase();
  if (names && lower in names) return names[lower]!;
  const n = Number(token);
  return Number.isInteger(n) ? n : Number.NaN;
}

function parseField(field: string, min: number, max: number, names: Record<string, number> | null): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    if (!rangePart || (stepPart !== undefined && stepPart === '')) return null;
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) return null;
    let lo: number; let hi: number;
    if (rangePart === '*') {
      lo = min; hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      lo = resolveToken(a ?? '', names);
      hi = resolveToken(b ?? '', names);
      if (Number.isNaN(lo) || Number.isNaN(hi) || lo > hi) return null;
    } else {
      lo = resolveToken(rangePart, names);
      hi = lo;
      if (Number.isNaN(lo)) return null;
      // A bare value with a step means "from value to max" (cron convention).
      if (stepPart !== undefined) hi = max;
    }
    // Day-of-week 7 == Sunday.
    if (names === DAY_NAMES) {
      if (lo === 7) lo = 0;
      if (hi === 7 && lo !== 0) hi = 6; // range ending at 7 → treat as sat, sunday covered by 0 usage
    }
    if (lo < min || hi > max) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size > 0 ? out : null;
}

export function parseCron(expression: string): CronSpec | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [m, h, dom, mon, dow] = fields as [string, string, string, string, string];
  const minute = parseField(m, 0, 59, null);
  const hour = parseField(h, 0, 23, null);
  const dayOfMonth = parseField(dom, 1, 31, null);
  const month = parseField(mon, 1, 12, MONTH_NAMES);
  const dayOfWeek = parseField(dow.replace(/\b7\b/g, '0'), 0, 6, DAY_NAMES);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return null;
  return { minute, hour, dayOfMonth, month, dayOfWeek, domAny: dom === '*', dowAny: dow === '*' };
}

/** Next fire strictly AFTER `from`. Null = invalid expression or no match within 400 days. */
export function nextCronFire(expression: string, from: Date = new Date()): Date | null {
  const spec = parseCron(expression);
  if (!spec) return null;

  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

  const limit = from.getTime() + 400 * 24 * 60 * 60 * 1000;
  while (cursor.getTime() <= limit) {
    const month = cursor.getUTCMonth() + 1;
    if (!spec.month.has(month)) {
      // Jump to the 1st of the next month.
      cursor.setUTCMonth(cursor.getUTCMonth() + 1, 1);
      cursor.setUTCHours(0, 0, 0, 0);
      continue;
    }
    const dom = cursor.getUTCDate();
    const dow = cursor.getUTCDay();
    // Vixie rule: both restricted → OR; otherwise AND of the restricted one(s).
    const domMatch = spec.dayOfMonth.has(dom);
    const dowMatch = spec.dayOfWeek.has(dow);
    const dayMatch = (!spec.domAny && !spec.dowAny) ? (domMatch || dowMatch) : (domMatch && dowMatch);
    if (!dayMatch) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!spec.hour.has(cursor.getUTCHours())) {
      cursor.setUTCHours(cursor.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!spec.minute.has(cursor.getUTCMinutes())) {
      cursor.setUTCMinutes(cursor.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return cursor;
  }
  return null;
}

/**
 * Next fire for a cron whose fields are interpreted in an IANA timezone.
 * Scanning absolute minutes keeps DST transitions correct: skipped local times
 * do not fire, while repeated local times remain distinct instants.
 */
export function nextCronFireInTimezone(
  expression: string,
  timezone = 'UTC',
  from: Date = new Date(),
): Date | null {
  if (!timezone || timezone.toUpperCase() === 'UTC') return nextCronFire(expression, from);
  const spec = parseCron(expression);
  if (!spec) return null;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
    });
  } catch {
    return null;
  }
  const weekday = new Map([
    ['Sun', 0], ['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6],
  ]);
  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  const limit = from.getTime() + 400 * 24 * 60 * 60 * 1000;
  while (cursor.getTime() <= limit) {
    const parts = Object.fromEntries(
      formatter.formatToParts(cursor).map((part) => [part.type, part.value]),
    );
    const month = Number(parts.month);
    const dom = Number(parts.day);
    const dow = weekday.get(parts.weekday ?? '') ?? -1;
    const hour = Number(parts.hour);
    const minute = Number(parts.minute);
    const domMatch = spec.dayOfMonth.has(dom);
    const dowMatch = spec.dayOfWeek.has(dow);
    const dayMatch = (!spec.domAny && !spec.dowAny) ? (domMatch || dowMatch) : (domMatch && dowMatch);
    if (
      spec.month.has(month)
      && dayMatch
      && spec.hour.has(hour)
      && spec.minute.has(minute)
    ) return new Date(cursor);
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}

/** Human hint for a cron expression ("daily 09:00", "every 15 min", …); falls back to the raw expr. */
export function describeCron(expression: string): string {
  const spec = parseCron(expression);
  if (!spec) return expression;
  const one = (s: Set<number>) => (s.size === 1 ? [...s][0]! : null);
  const minuteOne = one(spec.minute);
  const hourOne = one(spec.hour);
  const pad = (n: number) => String(n).padStart(2, '0');
  const everyDay = spec.domAny && spec.dowAny && spec.month.size === 12;
  if (minuteOne !== null && hourOne !== null && everyDay) return `daily ${pad(hourOne)}:${pad(minuteOne)}`;
  if (minuteOne !== null && spec.hour.size === 24 && everyDay) return minuteOne === 0 ? 'hourly' : `hourly at :${pad(minuteOne)}`;
  if (spec.minute.size > 1 && spec.hour.size === 24 && everyDay) {
    const sorted = [...spec.minute].sort((a, b) => a - b);
    const gap = sorted.length > 1 ? sorted[1]! - sorted[0]! : 60;
    if (sorted.every((v, i) => i === 0 || v - sorted[i - 1]! === gap)) return `every ${gap} min`;
  }
  if (minuteOne !== null && hourOne !== null && !spec.dowAny && spec.dayOfWeek.size < 7) {
    const dayLabels = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const days = [...spec.dayOfWeek].sort((a, b) => a - b).map((d) => dayLabels[d]).join(',');
    return `${days} ${pad(hourOne)}:${pad(minuteOne)}`;
  }
  return expression;
}
