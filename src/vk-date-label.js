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
 * Pulls "в 10:30" / "at 10:30" / "3:03 PM" / bare "10:30" out of a label.
 *
 * The English VK interface uses a 12-hour clock, so the meridiem is not optional
 * detail: dropping it puts every afternoon post twelve hours early.
 *
 * @returns {{hours: number, minutes: number}|null}
 */
const matchTime = (label) => {
    const match = /(?:^|\s)(?:в|at)?\s*(\d{1,2}):(\d{2})\s*(am|pm|a\.m\.|p\.m\.)?/i.exec(label);
    if (!match) return null;

    let hours = Number(match[1]);
    const minutes = Number(match[2]);
    const meridiem = match[3]?.replace(/\./g, '').toLowerCase();

    if (minutes > 59) return null;

    if (meridiem) {
        // A 12-hour clock only ever reads 1-12; anything else is a misparse.
        if (hours < 1 || hours > 12) return null;
        if (meridiem === 'pm' && hours !== 12) hours += 12;
        if (meridiem === 'am' && hours === 12) hours = 0;
    } else if (hours > 23) {
        return null;
    }

    return { hours, minutes };
};

/**
 * Reads the calendar fields a given instant has inside `timeZone`.
 * @param {Date} date @param {string} timeZone IANA zone name.
 */
const zonedParts = (date, timeZone) => {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });

    const parts = {};
    for (const { type, value } of formatter.formatToParts(date)) parts[type] = value;

    return {
        year: Number(parts.year),
        month: Number(parts.month) - 1,
        day: Number(parts.day),
        // Some engines render midnight as hour 24.
        hours: parts.hour === '24' ? 0 : Number(parts.hour),
        minutes: Number(parts.minute),
        seconds: Number(parts.second),
    };
};

/** How far `timeZone` is ahead of UTC at a given instant, in milliseconds. */
const zoneOffsetMs = (date, timeZone) => {
    const p = zonedParts(date, timeZone);
    return Date.UTC(p.year, p.month, p.day, p.hours, p.minutes, p.seconds) - date.getTime();
};

/**
 * Converts a wall-clock reading in `timeZone` to the instant it denotes.
 * Resolved twice so daylight-saving boundaries land on the correct side.
 */
const wallClockToUtc = ({ year, month, day, hours = 0, minutes = 0 }, timeZone) => {
    const naive = Date.UTC(year, month, day, hours, minutes);
    const firstPass = naive - zoneOffsetMs(new Date(naive), timeZone);
    return new Date(naive - zoneOffsetMs(new Date(firstPass), timeZone));
};

/**
 * @param {string} timeZone
 * @returns {boolean} Whether the runtime recognises this IANA zone.
 */
export const isValidTimeZone = (timeZone) => {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone }).format();
        return true;
    } catch {
        return false;
    }
};

/** Drops seconds and milliseconds; VK never states an age that precisely. */
const toMinute = (date) => new Date(Math.floor(date.getTime() / 60_000) * 60_000);

/** "только что" / "just now" - within a minute of now. */
const JUST_NOW = /^(только\s+что|just\s+now|now)$/i;

/**
 * Relative-age units VK prints on recent posts, in seconds. Patterns are fully
 * anchored: a loose `/^m/` would read "months" as minutes.
 *
 * Months and years are deliberately absent. VK switches to an absolute date well
 * before then, and approximating a month as 30 days would put a post up to two
 * weeks from where it belongs - worse than reporting no date at all.
 */
// `\w` is ASCII-only in JavaScript, so Cyrillic suffixes need `\p{L}` with /u.
const AGO_UNITS = [
    { pattern: /^(с|сек|секунд\p{L}*|s|sec|secs|second|seconds)$/iu, seconds: 1 },
    { pattern: /^(м|мин|минут\p{L}*|m|min|mins|minute|minutes)$/iu, seconds: 60 },
    { pattern: /^(ч|час\p{L}*|h|hr|hrs|hour|hours)$/iu, seconds: 3600 },
    { pattern: /^(д|дн|дня|дней|день|d|day|days)$/iu, seconds: 86_400 },
    { pattern: /^(нед|недел\p{L}*|w|wk|week|weeks)$/iu, seconds: 604_800 },
];

/**
 * VK spells small counts as words ("four hours ago"), so digits alone are not
 * enough. Indefinite articles ("an hour ago") mean one.
 */
const WORD_NUMBERS = new Map(Object.entries({
    a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    один: 1, одну: 1, одна: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5,
    шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10,
}));

/**
 * @param {string} token A digit string or a number word.
 * @returns {number|null}
 */
const readAmount = (token) => {
    if (/^\d+$/.test(token)) return Number(token);
    return WORD_NUMBERS.get(token) ?? null;
};

/**
 * Parses "5 минут назад" / "2 ч назад" / "3 days ago" / "four hours ago".
 * @returns {Date|null}
 */
const matchRelativeAge = (text, now) => {
    const match = /^([a-zа-я]+|\d+)\s*([a-zа-я]+)\.?\s*(назад|ago)$/i.exec(text);
    if (!match) return null;

    const amount = readAmount(match[1]);
    const unit = AGO_UNITS.find(({ pattern }) => pattern.test(match[2]));
    if (unit === undefined || amount === null || !Number.isFinite(amount)) return null;

    return new Date(now.getTime() - amount * unit.seconds * 1000);
};

/**
 * @param {string|null|undefined} label Raw text VK printed, e.g. "12 авг в 10:30".
 * @param {object} [options]
 * @param {Date} [options.now] Reference point for relative labels.
 * @param {string} [options.timeZone] IANA zone VK rendered the label in. Clock
 *   readings are wall-clock times in this zone; relative ages ("2 ч назад") are
 *   zone-independent and are never shifted.
 * @returns {{ iso: string, isExact: boolean }|null} `isExact` is false when the
 *   label carried no time of day, so the timestamp is the start of that date.
 */
export const parseVkDateLabel = (label, { now = new Date(), timeZone = 'UTC' } = {}) => {
    if (typeof label !== 'string') return null;
    const text = label.trim().toLowerCase();
    if (!text) return null;

    // An age is only ever accurate to the unit VK printed, so seconds and
    // milliseconds carried over from `now` would be invented precision.
    if (JUST_NOW.test(text)) return { iso: toMinute(now).toISOString(), isExact: false };

    // "5 минут назад" / "2 ч назад" / "3 days ago" - an age, not a clock reading.
    const relative = matchRelativeAge(text, now);
    if (relative) return { iso: toMinute(relative).toISOString(), isExact: false };

    const time = matchTime(text);

    // A malformed clock ("в 25:00") means the label is not what we think it is;
    // silently dropping to a date-only timestamp would invent precision.
    if (!time && HAS_CLOCK.test(text)) return null;

    // "сегодня в 21:04" / "вчера в 09:12" - relative to today *in VK's zone*.
    if (TODAY.test(text) || YESTERDAY.test(text)) {
        if (!time) return null;
        const today = zonedParts(now, timeZone);
        const date = wallClockToUtc(
            { year: today.year, month: today.month, day: today.day, ...time },
            timeZone,
        );
        if (YESTERDAY.test(text)) date.setUTCDate(date.getUTCDate() - 1);
        return { iso: date.toISOString(), isExact: true };
    }

    // "12 авг 2024 в 10:30" / "12 авг в 10:30" / "12 aug 2024"
    const dayMonth = /^(\d{1,2})\s+([a-zа-я]+)\.?(?:\s+(\d{4}))?/i.exec(text);
    if (!dayMonth) return null;

    const day = Number(dayMonth[1]);
    const month = MONTHS.get(dayMonth[2].slice(0, 3));
    if (month === undefined || day < 1 || day > 31) return null;

    // Guard against overflow like "31 фев" silently rolling into March.
    const probe = new Date(Date.UTC(2000, month, day));
    if (probe.getUTCMonth() !== month || probe.getUTCDate() !== day) return null;

    // VK omits the year for posts from the current year.
    const labelledYear = dayMonth[3] ? Number(dayMonth[3]) : zonedParts(now, timeZone).year;
    let date = wallClockToUtc(
        { year: labelledYear, month, day, hours: time?.hours ?? 0, minutes: time?.minutes ?? 0 },
        timeZone,
    );

    // A yearless label can only mean the past; if it lands in the future, VK meant last year.
    if (!dayMonth[3] && date.getTime() > now.getTime()) {
        date = wallClockToUtc(
            { year: labelledYear - 1, month, day, hours: time?.hours ?? 0, minutes: time?.minutes ?? 0 },
            timeZone,
        );
    }

    return { iso: date.toISOString(), isExact: Boolean(time) };
};
