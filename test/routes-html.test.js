import { beforeEach, describe, expect, it, vi } from 'vitest';

const pushed = [];

vi.mock('apify', () => ({
    Actor: { pushData: vi.fn(async (items) => { pushed.push(...items); }) },
    log: {
        info: vi.fn(), warning: vi.fn(), error: vi.fn(), debug: vi.fn(), softFail: vi.fn(),
    },
}));

const { ResultCollector } = await import('../src/results.js');
const { HTML_LABELS, createHtmlRouter, extractPostsInPage } = await import('../src/routes-html.js');

const baseConfig = {
    maxItems: 100,
    postsPerTarget: null,
    publishedAfter: null,
    publishedBefore: null,
    keepUndatedPosts: false,
    htmlTimezone: 'Europe/Moscow',
};

/** A post as `extractPostsInPage` would return it. */
const rawPost = (ownerId, postId, overrides = {}) => ({
    ownerId,
    postId,
    text: `post ${postId}`,
    postedAtUnix: 1_700_000_000,
    postedAtText: null,
    headerSample: null,
    likes: 1,
    comments: null,
    reposts: null,
    views: null,
    isPinned: false,
    isRepost: false,
    thumbnails: [],
    mediaTypes: [],
    ...overrides,
});

/**
 * Drives the handler with a fake page. `extractPostsInPage` is identified by
 * function identity so the two `evaluate` shapes can be told apart.
 */
const runHandler = async ({ posts, userData, config = baseConfig, collector, wasScoped = true }) => {
    const router = createHtmlRouter({ collector, config });
    const enqueued = [];

    const page = {
        waitForSelector: vi.fn().mockResolvedValue(true),
        waitForFunction: vi.fn().mockRejectedValue(new Error('no growth')),
        $: vi.fn().mockResolvedValue(null),
        evaluate: vi.fn(async (fn) => (fn === extractPostsInPage ? { posts, wasScoped } : posts.length)),
    };

    await router(
        {
            page,
            request: { label: HTML_LABELS.WALL, userData: { label: HTML_LABELS.WALL, ...userData } },
            crawler: { addRequests: async (reqs) => enqueued.push(...reqs) },
            log: {
                debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn(),
            },
        },
        { label: HTML_LABELS.WALL },
    );

    return { enqueued };
};

const walkerUserData = (extra = {}) => ({
    target: 'https://vk.com/vkvideo',
    targetType: 'url',
    ownerId: null,
    offset: 0,
    storedSoFar: 0,
    pageIndex: 0,
    ...extra,
});

beforeEach(() => {
    pushed.length = 0;
});

describe('HTML wall handler', () => {
    it('keeps only posts belonging to the wall being scraped', async () => {
        const collector = new ResultCollector({ maxItems: 100 });
        await runHandler({
            // Three from the wall, two from recommendation rails.
            posts: [
                rawPost(-220754053, 1), rawPost(-220754053, 2), rawPost(-220754053, 3),
                rawPost(-217672812, 4), rawPost(-207536086, 5),
            ],
            userData: walkerUserData(),
            collector,
        });

        expect(pushed).toHaveLength(3);
        expect(new Set(pushed.map((p) => p.ownerId))).toEqual(new Set([-220754053]));
    });

    it('trusts an explicit owner ID over the majority of posts on the page', async () => {
        const collector = new ResultCollector({ maxItems: 100 });
        await runHandler({
            // The foreign community outnumbers the wall here.
            posts: [rawPost(-1, 1), rawPost(-999, 2), rawPost(-999, 3), rawPost(-999, 4)],
            userData: walkerUserData({ ownerId: -1 }),
            collector,
        });

        expect(pushed.map((p) => p.postId)).toEqual(['-1_1']);
    });

    it('follows the wall to the next offset while posts keep arriving', async () => {
        const collector = new ResultCollector({ maxItems: 100 });
        const { enqueued } = await runHandler({
            posts: [rawPost(-1, 1), rawPost(-1, 2)],
            userData: walkerUserData({ ownerId: -1 }),
            collector,
        });

        expect(enqueued).toHaveLength(1);
        expect(enqueued[0].url).toBe('https://m.vk.com/wall-1?offset=2');
        expect(enqueued[0].userData).toMatchObject({ offset: 2, storedSoFar: 2, pageIndex: 1 });
    });

    it('carries the running total forward so later pages respect the budget', async () => {
        const collector = new ResultCollector({ maxItems: 100 });
        const { enqueued } = await runHandler({
            posts: [rawPost(-1, 10), rawPost(-1, 11)],
            userData: walkerUserData({ ownerId: -1, offset: 40, storedSoFar: 40, pageIndex: 2 }),
            collector,
        });

        expect(enqueued[0].url).toBe('https://m.vk.com/wall-1?offset=42');
        expect(enqueued[0].userData).toMatchObject({ storedSoFar: 42, pageIndex: 3 });
    });

    it('stops paginating when a page adds nothing new', async () => {
        const collector = new ResultCollector({ maxItems: 100 });
        // Pre-seed the collector so every post on this page is a duplicate.
        await collector.push([{ postId: '-1_1' }, { postId: '-1_2' }]);
        pushed.length = 0;

        const { enqueued } = await runHandler({
            posts: [rawPost(-1, 1), rawPost(-1, 2)],
            userData: walkerUserData({ ownerId: -1 }),
            collector,
        });

        expect(pushed).toHaveLength(0);
        expect(enqueued).toHaveLength(0);
    });

    it('stops paginating once the per-target limit is reached', async () => {
        const collector = new ResultCollector({ maxItems: 100 });
        const { enqueued } = await runHandler({
            posts: [rawPost(-1, 1), rawPost(-1, 2)],
            userData: walkerUserData({ ownerId: -1 }),
            config: { ...baseConfig, postsPerTarget: 2 },
            collector,
        });

        expect(pushed).toHaveLength(2);
        expect(enqueued).toHaveLength(0);
    });

    it('stops paginating once the global budget is spent', async () => {
        const collector = new ResultCollector({ maxItems: 2 });
        const { enqueued } = await runHandler({
            posts: [rawPost(-1, 1), rawPost(-1, 2), rawPost(-1, 3)],
            userData: walkerUserData({ ownerId: -1 }),
            config: { ...baseConfig, maxItems: 2 },
            collector,
        });

        expect(pushed).toHaveLength(2);
        expect(enqueued).toHaveLength(0);
    });

    it('gives up after the page cap rather than walking a wall forever', async () => {
        const collector = new ResultCollector({ maxItems: 10_000 });
        const { enqueued } = await runHandler({
            posts: [rawPost(-1, 500)],
            userData: walkerUserData({ ownerId: -1, pageIndex: 25, offset: 500, storedSoFar: 500 }),
            collector,
        });

        expect(enqueued).toHaveLength(0);
    });

    it('fails loudly when every post found belongs to another community', async () => {
        const collector = new ResultCollector({ maxItems: 100 });
        await expect(runHandler({
            posts: [rawPost(-999, 1), rawPost(-888, 2)],
            userData: walkerUserData({ ownerId: -1 }),
            collector,
        })).rejects.toThrow(/different community/);

        expect(pushed).toHaveLength(0);
    });

    it('drops undated posts when a date filter is set, unless asked to keep them', async () => {
        const undated = { postedAtUnix: null, postedAtText: null };

        const strict = new ResultCollector({ maxItems: 100 });
        await runHandler({
            posts: [rawPost(-1, 1, undated), rawPost(-1, 2)],
            userData: walkerUserData({ ownerId: -1 }),
            config: { ...baseConfig, publishedAfter: new Date('2020-01-01') },
            collector: strict,
        });
        expect(pushed.map((p) => p.postId)).toEqual(['-1_2']);

        pushed.length = 0;
        const lenient = new ResultCollector({ maxItems: 100 });
        await runHandler({
            posts: [rawPost(-1, 1, undated), rawPost(-1, 2)],
            userData: walkerUserData({ ownerId: -1 }),
            config: { ...baseConfig, publishedAfter: new Date('2020-01-01'), keepUndatedPosts: true },
            collector: lenient,
        });
        expect(pushed.map((p) => p.postId)).toEqual(['-1_1', '-1_2']);
    });
});
