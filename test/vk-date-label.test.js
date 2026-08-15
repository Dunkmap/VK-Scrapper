import { describe, expect, it } from 'vitest';

import { parseVkDateLabel } from '../src/vk-date-label.js';

// Fixed reference point so relative labels are deterministic.
const NOW = new Date('2024-08-12T15:00:00.000Z');

describe('parseVkDateLabel', () => {
    it.each([
        ['12 авг 2024 в 10:30', '2024-08-12T10:30:00.000Z'],
        ['1 янв 2020 в 00:05', '2020-01-01T00:05:00.000Z'],
        ['31 дек 2023 в 23:59', '2023-12-31T23:59:00.000Z'],
        ['9 мая 2023 в 07:00', '2023-05-09T07:00:00.000Z'],
    ])('parses the full Russian label %s', (label, expected) => {
        expect(parseVkDateLabel(label, { now: NOW }).iso).toBe(expected);
    });

    it.each([
        ['12 aug 2024 at 10:30', '2024-08-12T10:30:00.000Z'],
        ['3 mar 2021', '2021-03-03T00:00:00.000Z'],
    ])('parses the English label %s', (label, expected) => {
        expect(parseVkDateLabel(label, { now: NOW }).iso).toBe(expected);
    });

    it('assumes the current year when VK omits it', () => {
        expect(parseVkDateLabel('5 авг в 09:15', { now: NOW }).iso).toBe('2024-08-05T09:15:00.000Z');
    });

    it('rolls a yearless label back when it would land in the future', () => {
        // 1 December has not happened yet in the reference year, so VK means last year.
        expect(parseVkDateLabel('1 дек в 12:00', { now: NOW }).iso).toBe('2023-12-01T12:00:00.000Z');
    });

    it.each([
        ['сегодня в 21:04', '2024-08-12T21:04:00.000Z'],
        ['today at 08:00', '2024-08-12T08:00:00.000Z'],
        ['вчера в 09:12', '2024-08-11T09:12:00.000Z'],
        ['yesterday at 23:30', '2024-08-11T23:30:00.000Z'],
    ])('resolves the relative label %s', (label, expected) => {
        expect(parseVkDateLabel(label, { now: NOW }).iso).toBe(expected);
    });

    it.each([
        ['5 минут назад', '2024-08-12T14:55:00.000Z'],
        ['5 мин назад', '2024-08-12T14:55:00.000Z'],
        ['2 часа назад', '2024-08-12T13:00:00.000Z'],
        ['2 ч назад', '2024-08-12T13:00:00.000Z'],
        ['3 дня назад', '2024-08-09T15:00:00.000Z'],
        ['3 days ago', '2024-08-09T15:00:00.000Z'],
        ['30 sec ago', '2024-08-12T14:59:30.000Z'],
        ['1 week ago', '2024-08-05T15:00:00.000Z'],
    ])('resolves the relative age %s', (label, expected) => {
        expect(parseVkDateLabel(label, { now: NOW }).iso).toBe(expected);
    });

    // Regression: VK served "four hours ago" and the digits-only pattern missed it.
    it.each([
        ['four hours ago', '2024-08-12T11:00:00.000Z'],
        ['an hour ago', '2024-08-12T14:00:00.000Z'],
        ['a minute ago', '2024-08-12T14:59:00.000Z'],
        ['one day ago', '2024-08-11T15:00:00.000Z'],
        ['two weeks ago', '2024-07-29T15:00:00.000Z'],
        ['twelve minutes ago', '2024-08-12T14:48:00.000Z'],
        ['три часа назад', '2024-08-12T12:00:00.000Z'],
        ['две недели назад', '2024-07-29T15:00:00.000Z'],
    ])('resolves the spelled-out age %s', (label, expected) => {
        expect(parseVkDateLabel(label, { now: NOW }).iso).toBe(expected);
    });

    // Regression: the English VK interface uses a 12-hour clock. Ignoring the
    // meridiem put every afternoon post exactly twelve hours early.
    describe('12-hour clock', () => {
        it.each([
            ['12 aug 2024 at 3:03 pm', '2024-08-12T15:03:00.000Z'],
            ['12 aug 2024 at 3:03 am', '2024-08-12T03:03:00.000Z'],
            ['12 aug 2024 at 12:30 am', '2024-08-12T00:30:00.000Z'],
            ['12 aug 2024 at 12:30 pm', '2024-08-12T12:30:00.000Z'],
            ['12 aug 2024 at 11:59 PM', '2024-08-12T23:59:00.000Z'],
            ['12 aug 2024 at 1:05 p.m.', '2024-08-12T13:05:00.000Z'],
        ])('reads %s correctly', (label, expected) => {
            expect(parseVkDateLabel(label, { now: NOW }).iso).toBe(expected);
        });

        it('applies the meridiem to relative day labels too', () => {
            expect(parseVkDateLabel('today at 3:03 pm', { now: NOW }).iso).toBe('2024-08-12T15:03:00.000Z');
            expect(parseVkDateLabel('yesterday at 9:12 pm', { now: NOW }).iso).toBe('2024-08-11T21:12:00.000Z');
        });

        it('still reads a 24-hour clock when no meridiem is present', () => {
            expect(parseVkDateLabel('12 авг 2024 в 15:03', { now: NOW }).iso).toBe('2024-08-12T15:03:00.000Z');
            expect(parseVkDateLabel('12 авг 2024 в 00:30', { now: NOW }).iso).toBe('2024-08-12T00:30:00.000Z');
        });

        it('rejects an hour that cannot exist on a 12-hour clock', () => {
            expect(parseVkDateLabel('12 aug 2024 at 15:03 pm', { now: NOW })).toBeNull();
            expect(parseVkDateLabel('12 aug 2024 at 0:30 am', { now: NOW })).toBeNull();
        });

        it('converts the meridiem before applying the timezone, not after', () => {
            // 3:03 PM Moscow is 12:03 UTC - the exact case seen in production.
            expect(parseVkDateLabel('12 aug 2024 at 3:03 pm', { now: NOW, timeZone: 'Europe/Moscow' }).iso)
                .toBe('2024-08-12T12:03:00.000Z');
        });
    });

    it('reports relative ages to the minute, not the millisecond', () => {
        const odd = new Date('2024-08-12T15:00:51.310Z');
        expect(parseVkDateLabel('four hours ago', { now: odd }).iso).toBe('2024-08-12T11:00:00.000Z');
        expect(parseVkDateLabel('только что', { now: odd }).iso).toBe('2024-08-12T15:00:00.000Z');
    });

    it('does not mistake months for minutes', () => {
        // A loose /^m/ unit pattern once read "months" as "minutes".
        expect(parseVkDateLabel('3 months ago', { now: NOW })).toBeNull();
        expect(parseVkDateLabel('a month ago', { now: NOW })).toBeNull();
    });

    it('does not approximate ages coarser than a week', () => {
        expect(parseVkDateLabel('2 years ago', { now: NOW })).toBeNull();
    });

    it('treats "только что" as now, flagged approximate', () => {
        expect(parseVkDateLabel('только что', { now: NOW }))
            .toEqual({ iso: NOW.toISOString(), isExact: false });
        expect(parseVkDateLabel('just now', { now: NOW }).iso).toBe(NOW.toISOString());
    });

    it('marks relative ages as approximate, not exact', () => {
        expect(parseVkDateLabel('2 ч назад', { now: NOW }).isExact).toBe(false);
    });

    it('flags whether a time of day was present', () => {
        expect(parseVkDateLabel('12 авг 2024 в 10:30', { now: NOW }).isExact).toBe(true);
        expect(parseVkDateLabel('12 авг 2024', { now: NOW }).isExact).toBe(false);
    });

    it('starts the day when no time is given, rather than guessing one', () => {
        expect(parseVkDateLabel('12 авг 2024', { now: NOW }).iso).toBe('2024-08-12T00:00:00.000Z');
    });

    it.each([
        ['', 'empty'],
        ['   ', 'blank'],
        [null, 'null'],
        [undefined, 'undefined'],
        [42, 'a number'],
        ['recently', 'a vague phrase with no anchor'],
        ['много лет назад', 'a relative age with no number'],
        ['32 авг 2024', 'an impossible day'],
        ['31 фев 2024', 'a day that overflows its month'],
        ['12 xyz 2024', 'an unknown month'],
        ['сегодня', 'a relative label with no time'],
        ['12 авг 2024 в 25:00', 'an impossible hour'],
    ])('returns null for %s (%s)', (label) => {
        expect(parseVkDateLabel(label, { now: NOW })).toBeNull();
    });

    describe('timezone resolution', () => {
        it('reads a clock time as wall-clock in the given zone', () => {
            // 10:30 in Moscow (UTC+3) is 07:30 UTC.
            expect(parseVkDateLabel('12 авг 2024 в 10:30', { now: NOW, timeZone: 'Europe/Moscow' }).iso)
                .toBe('2024-08-12T07:30:00.000Z');
        });

        it('defaults to UTC when no zone is given', () => {
            expect(parseVkDateLabel('12 авг 2024 в 10:30', { now: NOW }).iso)
                .toBe('2024-08-12T10:30:00.000Z');
        });

        it('resolves "сегодня" against today in the target zone, not UTC', () => {
            // 00:30 UTC is already 03:30 on the same day in Moscow.
            const nearMidnight = new Date('2024-08-12T00:30:00.000Z');
            expect(parseVkDateLabel('сегодня в 03:30', { now: nearMidnight, timeZone: 'Europe/Moscow' }).iso)
                .toBe('2024-08-12T00:30:00.000Z');
        });

        it('applies the correct offset either side of a daylight-saving change', () => {
            // Berlin is UTC+1 in January and UTC+2 in July.
            expect(parseVkDateLabel('15 янв 2024 в 12:00', { now: NOW, timeZone: 'Europe/Berlin' }).iso)
                .toBe('2024-01-15T11:00:00.000Z');
            expect(parseVkDateLabel('15 июл 2024 в 12:00', { now: NOW, timeZone: 'Europe/Berlin' }).iso)
                .toBe('2024-07-15T10:00:00.000Z');
        });

        it('never shifts a relative age, which carries no timezone', () => {
            expect(parseVkDateLabel('2 ч назад', { now: NOW, timeZone: 'Europe/Moscow' }).iso)
                .toBe('2024-08-12T13:00:00.000Z');
            expect(parseVkDateLabel('только что', { now: NOW, timeZone: 'Asia/Tokyo' }).iso)
                .toBe(NOW.toISOString());
        });

        it('handles a zone behind UTC', () => {
            // 20:00 in New York (UTC-4 in August) is 00:00 UTC the next day.
            expect(parseVkDateLabel('12 авг 2024 в 20:00', { now: NOW, timeZone: 'America/New_York' }).iso)
                .toBe('2024-08-13T00:00:00.000Z');
        });
    });

    it('never returns an invalid Date', () => {
        const labels = ['12 авг 2024 в 10:30', '5 авг', 'сегодня в 00:00', 'вчера в 23:59'];
        for (const label of labels) {
            const result = parseVkDateLabel(label, { now: NOW });
            if (result) expect(Number.isNaN(Date.parse(result.iso))).toBe(false);
        }
    });
});
