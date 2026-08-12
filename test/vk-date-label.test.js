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
        expect(parseVkDateLabel(label, NOW).iso).toBe(expected);
    });

    it.each([
        ['12 aug 2024 at 10:30', '2024-08-12T10:30:00.000Z'],
        ['3 mar 2021', '2021-03-03T00:00:00.000Z'],
    ])('parses the English label %s', (label, expected) => {
        expect(parseVkDateLabel(label, NOW).iso).toBe(expected);
    });

    it('assumes the current year when VK omits it', () => {
        expect(parseVkDateLabel('5 авг в 09:15', NOW).iso).toBe('2024-08-05T09:15:00.000Z');
    });

    it('rolls a yearless label back when it would land in the future', () => {
        // 1 December has not happened yet in the reference year, so VK means last year.
        expect(parseVkDateLabel('1 дек в 12:00', NOW).iso).toBe('2023-12-01T12:00:00.000Z');
    });

    it.each([
        ['сегодня в 21:04', '2024-08-12T21:04:00.000Z'],
        ['today at 08:00', '2024-08-12T08:00:00.000Z'],
        ['вчера в 09:12', '2024-08-11T09:12:00.000Z'],
        ['yesterday at 23:30', '2024-08-11T23:30:00.000Z'],
    ])('resolves the relative label %s', (label, expected) => {
        expect(parseVkDateLabel(label, NOW).iso).toBe(expected);
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
        expect(parseVkDateLabel(label, NOW).iso).toBe(expected);
    });

    it('treats "только что" as now, flagged approximate', () => {
        expect(parseVkDateLabel('только что', NOW)).toEqual({ iso: NOW.toISOString(), isExact: false });
        expect(parseVkDateLabel('just now', NOW).iso).toBe(NOW.toISOString());
    });

    it('marks relative ages as approximate, not exact', () => {
        expect(parseVkDateLabel('2 ч назад', NOW).isExact).toBe(false);
    });

    it('flags whether a time of day was present', () => {
        expect(parseVkDateLabel('12 авг 2024 в 10:30', NOW).isExact).toBe(true);
        expect(parseVkDateLabel('12 авг 2024', NOW).isExact).toBe(false);
    });

    it('starts the day when no time is given, rather than guessing one', () => {
        expect(parseVkDateLabel('12 авг 2024', NOW).iso).toBe('2024-08-12T00:00:00.000Z');
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
        expect(parseVkDateLabel(label, NOW)).toBeNull();
    });

    it('never returns an invalid Date', () => {
        const labels = ['12 авг 2024 в 10:30', '5 авг', 'сегодня в 00:00', 'вчера в 23:59'];
        for (const label of labels) {
            const result = parseVkDateLabel(label, NOW);
            if (result) expect(Number.isNaN(Date.parse(result.iso))).toBe(false);
        }
    });
});
