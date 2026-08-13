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
