import { describe, expect, it } from 'vitest';

import { describeTarget, parseTarget } from '../src/targets.js';

describe('parseTarget', () => {
    it('accepts a bare handle', () => {
        expect(parseTarget('durov')).toEqual({
            kind: 'wall', raw: 'durov', targetType: 'handle', domain: 'durov',
        });
    });

    it('lowercases handles and strips a leading @', () => {
        expect(parseTarget('@KinoPoisk').domain).toBe('kinopoisk');
    });

    it('converts club/public/event/id aliases to signed owner IDs', () => {
        expect(parseTarget('club1').ownerId).toBe(-1);
        expect(parseTarget('public42').ownerId).toBe(-42);
        expect(parseTarget('event7').ownerId).toBe(-7);
        expect(parseTarget('id5').ownerId).toBe(5);
    });

    it('accepts a bare signed owner ID', () => {
        expect(parseTarget('-40316705')).toEqual({
            kind: 'wall', raw: '-40316705', targetType: 'ownerId', ownerId: -40316705,
        });
    });

    it.each([
        'https://vk.com/durov',
        'http://m.vk.com/durov',
        'https://www.vk.com/durov/',
        'vk.com/durov',
        'https://vk.ru/durov',
    ])('normalizes profile URL %s', (url) => {
        const target = parseTarget(url);
        expect(target).toMatchObject({ kind: 'wall', targetType: 'url', domain: 'durov' });
    });

    it('reads a wall URL addressed by owner ID', () => {
        expect(parseTarget('https://vk.com/wall-1')).toMatchObject({ kind: 'wall', ownerId: -1 });
    });

    it.each([
        ['https://vk.com/wall1_45678', 1, 45678],
        ['https://vk.com/wall-22822305_1070789', -22822305, 1070789],
        ['https://vk.com/durov?w=wall1_45678', 1, 45678],
        ['wall-1_2', -1, 2],
    ])('reads single post %s', (input, ownerId, postId) => {
        expect(parseTarget(input)).toMatchObject({ kind: 'post', ownerId, postId });
    });

    it('ignores query noise on a profile URL', () => {
        expect(parseTarget('https://vk.com/durov?from=search&utm_source=x').domain).toBe('durov');
    });

    it.each(['', '   ', 'https://twitter.com/durov', 'not a handle!', 'https://vk.com/'])(
        'rejects %s',
        (input) => {
            expect(() => parseTarget(input)).toThrow();
        },
    );

    it('rejects VK service pages', () => {
        expect(() => parseTarget('https://vk.com/dev/permissions')).toThrow(/service page/);
        expect(() => parseTarget('feed')).toThrow(/service page/);
    });
});

describe('describeTarget', () => {
    it('labels walls and posts', () => {
        expect(describeTarget(parseTarget('durov'))).toBe('durov');
        expect(describeTarget(parseTarget('-1'))).toBe('wall-1');
        expect(describeTarget(parseTarget('https://vk.com/wall1_2'))).toBe('wall1_2');
    });
});
