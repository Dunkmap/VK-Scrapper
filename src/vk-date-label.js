/**
 * Parses the human-readable date labels VK prints on wall posts.
 *
 * VK's public HTML rarely carries a machine-readable timestamp, so the only
 * date available is text like "12 авг в 10:30" or "сегодня в 21:04". This
 * module turns those into exact timestamps where the label allows it, and
 * returns `null` when it genuinely cannot - a wrong date is worse than none.
 */

/** Month name -> zero-based index. VK uses abbreviations, sometimes inflected. */
const MONTHS = new Map(Object.entries({
    янв: 0, фев: 1, мар: 2, апр: 3, мая: 4, май: 4, июн: 5,
    июл: 6, авг: 7, сен: 8, окт: 9, ноя: 10, дек: 11,
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}));

// `\b` is ASCII-only in JavaScript, so it never fires after a Cyrillic letter.
// A lookahead for "not a letter" is the portable equivalent.
const TODAY = /^(сегодня|today)(?![\p{L}])/iu;
const YESTERDAY = /^(вчера|yesterday)(?![\p{L}])/iu;

/** Any clock-shaped substring, valid or not. */
const HAS_CLOCK = /\d{1,2}:\d{2}/;

/**
 * Pulls "в 10:30" / "at 10:30" / bare "10:30" out of a label.
 * @returns {{hours: number, minutes: number}|null}
 */
const matchTime = (label) => {
    const match = /(?:^|\s)(?:в|at)?\s*(\d{1,2}):(\d{2})/i.exec(label);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return null;
    return { hours, minutes };
};

/** "только что" / "just now" - within a minute of now. */
const JUST_NOW = /^(только\s+что|just\s+now|now)$/i;

/** Relative-age units VK prints on recent posts, in seconds. */
const AGO_UNITS = [
    { pattern: /^(сек|sec|s)/i, seconds: 1 },
    { pattern: /^(мин|min|m)/i, seconds: 60 },
    { pattern: /^(ч|hour|hr|h)/i, seconds: 3600 },
    { pattern: /^(дн|день|дня|дней|day|d)/i, seconds: 86_400 },
    { pattern: /^(нед|week|w)/i, seconds: 604_800 },
];

/**
 * Parses "5 минут назад" / "2 ч назад" / "3 days ago".
 * @returns {Date|null}
 */
const matchRelativeAge = (text, now) => {
    const match = /^(\d+)\s*([a-zа-я]+)\.?\s*(назад|ago)$/i.exec(text);
    if (!match) return null;

    const amount = Number(match[1]);
    const unit = AGO_UNITS.find(({ pattern }) => pattern.test(match[2]));
    if (!unit || !Number.isFinite(amount)) return null;

    return new Date(now.getTime() - amount * unit.seconds * 1000);
};

/**
 * @param {string|null|undefined} label Raw text VK printed, e.g. "12 авг в 10:30".
 * @param {Date} [now] Reference point for relative labels; defaults to the current time.
 * @returns {{ iso: string, isExact: boolean }|null} `isExact` is false when the
 *   label carried no time of day, so the timestamp is the start of that date.
 */
export const parseVkDateLabel = (label, now = new Date()) => {
    if (typeof label !== 'string') return null;
    const text = label.trim().toLowerCase();
    if (!text) return null;

    if (JUST_NOW.test(text)) return { iso: now.toISOString(), isExact: false };

    // "5 минут назад" / "2 ч назад" / "3 days ago"
    const relative = matchRelativeAge(text, now);
    if (relative) return { iso: relative.toISOString(), isExact: false };

    const time = matchTime(text);

    // A malformed clock ("в 25:00") means the label is not what we think it is;
    // silently dropping to a date-only timestamp would invent precision.
    if (!time && HAS_CLOCK.test(text)) return null;

    // "сегодня в 21:04" / "вчера в 09:12"
    if (TODAY.test(text) || YESTERDAY.test(text)) {
        if (!time) return null;
        const date = new Date(Date.UTC(
            now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), time.hours, time.minutes,
        ));
        if (YESTERDAY.test(text)) date.setUTCDate(date.getUTCDate() - 1);
        return { iso: date.toISOString(), isExact: true };
    }

    // "12 авг 2024 в 10:30" / "12 авг в 10:30" / "12 aug 2024"
    const dayMonth = /^(\d{1,2})\s+([a-zа-я]+)\.?(?:\s+(\d{4}))?/i.exec(text);
    if (!dayMonth) return null;

    const day = Number(dayMonth[1]);
    const month = MONTHS.get(dayMonth[2].slice(0, 3));
    if (month === undefined || day < 1 || day > 31) return null;

    // VK omits the year for posts from the current year.
    const year = dayMonth[3] ? Number(dayMonth[3]) : now.getUTCFullYear();
    const date = new Date(Date.UTC(year, month, day, time?.hours ?? 0, time?.minutes ?? 0));

    // Guard against overflow like "31 фев" silently rolling into March.
    if (date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;

    // A yearless label can only mean the past; if it lands in the future, VK meant last year.
    if (!dayMonth[3] && date.getTime() > now.getTime()) {
        date.setUTCFullYear(year - 1);
    }

    return { iso: date.toISOString(), isExact: Boolean(time) };
};
