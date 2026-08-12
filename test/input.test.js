import { describe, expect, it, vi } from 'vitest';

vi.mock('apify', () => ({
    log: {
        info: vi.fn(), warning: vi.fn(), error: vi.fn(), debug: vi.fn(), softFail: vi.fn(),
    },
}));

const { validateInput } = await import('../src/input.js');

const withToken = (extra = {}) => validateInput({
    vkTargets: ['durov'],
    accessToken: 'vk1.a.token',
    ...extra,
});

describe('validateInput', () => {
    it('rejects missing input outright', () => {
        expect(() => validateInput(null)).toThrow(/No input provided/);
        expect(() => validateInput(undefined)).toThrow(/No input provided/);
    });

    it.each([{}, { vkTargets: [] }, { vkTargets: 'durov' }])('rejects bad vkTargets %s', (input) => {
        expect(() => validateInput(input)).toThrow(/vkTargets/);
    });

    it('fails when no target at all could be parsed', () => {
        expect(() => validateInput({ vkTargets: ['!!!', 'https://twitter.com/x'] }))
            .toThrow(/None of the supplied targets/);
    });

    it('keeps the good targets and skips the bad ones', () => {
        const { targets } = validateInput({ vkTargets: ['durov', '!!!', 'kinopoisk'] });
        expect(targets.map((t) => t.domain)).toEqual(['durov', 'kinopoisk']);
    });

    it('selects API mode when a token is present', () => {
        expect(withToken().config).toMatchObject({ mode: 'api', accessToken: 'vk1.a.token' });
    });

    it.each([undefined, null, '', '   '])('falls back to HTML mode for token %s', (accessToken) => {
        const { config } = validateInput({ vkTargets: ['durov'], accessToken });
        expect(config.mode).toBe('html');
        expect(config.accessToken).toBeNull();
    });

    it('ignores includeComments outside API mode', () => {
        expect(validateInput({ vkTargets: ['durov'], includeComments: true }).config.includeComments).toBe(false);
        expect(withToken({ includeComments: true }).config.includeComments).toBe(true);
    });

    it('applies the documented defaults', () => {
        expect(withToken().config).toMatchObject({
            maxItems: 500,
            postsPerTarget: null,
            postFilter: 'all',
            includeComments: false,
            maxComments: 100,
            includeRawPost: false,
            publishedAfter: null,
            publishedBefore: null,
        });
    });

    it.each([0, -1, 1.5, 'many'])('rejects maxItems %s', (maxItems) => {
        expect(() => withToken({ maxItems })).toThrow(/maxItems/);
    });

    it.each([0, -5, 2.5])('rejects postsPerTarget %s', (postsPerTarget) => {
        expect(() => withToken({ postsPerTarget })).toThrow(/postsPerTarget/);
    });

    it('rejects an unknown postFilter', () => {
        expect(() => withToken({ postFilter: 'everything' })).toThrow(/postFilter/);
    });

    it('rejects an inverted date window', () => {
        expect(() => withToken({ publishedAfter: '2024-06-01', publishedBefore: '2024-01-01' }))
            .toThrow(/earlier than/);
    });

    it('parses the date window into Date objects', () => {
        const { config } = withToken({ publishedAfter: '2024-01-01', publishedBefore: '2024-01-31' });
        expect(config.publishedAfter.toISOString()).toBe('2024-01-01T00:00:00.000Z');
        expect(config.publishedBefore.toISOString()).toBe('2024-01-31T23:59:59.999Z');
    });

    it('never requests a page larger than the budget', () => {
        expect(withToken({ maxItems: 10 }).config.pageSize).toBe(10);
        expect(withToken({ postsPerTarget: 5 }).config.pageSize).toBe(5);
        expect(withToken({ maxItems: 10_000 }).config.pageSize).toBe(100);
    });
});
