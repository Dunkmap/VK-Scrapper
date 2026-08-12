import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Collects everything the handlers push, standing in for the Apify dataset. */
const pushed = [];

vi.mock('apify', () => ({
    Actor: { pushData: vi.fn(async (items) => { pushed.push(...items); }) },
    log: {
        info: vi.fn(), warning: vi.fn(), error: vi.fn(), debug: vi.fn(), softFail: vi.fn(),
    },
}));

const { ResultCollector } = await import('../src/results.js');
const { RunState } = await import('../src/run-state.js');
const { createApiRouter, LABELS } = await import('../src/routes.js');
const { VkApiError } = await import('../src/vk-api.js');

/** Crawlee's router logs through the crawling context. */
const fakeLog = {
    debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn(),
};

/** Builds a `wall.get` envelope with `count` synthetic posts starting at `startId`. */
const wallPage = ({ total, startId, size, dayOffset = 0 }) => ({
    response: {
        count: total,
        items: Array.from({ length: size }, (_, i) => ({
            id: startId + i,
            owner_id: -1,
            from_id: -1,
            // One post per day, walking backwards from 2024-06-01.
            date: Math.floor(Date.UTC(2024, 5, 1) / 1000) - (startId + i + dayOffset) * 86_400,
            text: `post ${startId + i}`,
            likes: { count: 1 },
            comments: { count: 0 },
            reposts: { count: 0 },
            views: { count: 10 },
        })),
        profiles: [],
        groups: [{ id: 1, name: 'Test', screen_name: 'test' }],
    },
});

const baseConfig = {
    maxItems: 1000,
    postsPerTarget: null,
    publishedAfter: null,
    publishedBefore: null,
    postFilter: 'all',
    includeComments: false,
    maxComments: 100,
    includeRawPost: false,
    accessToken: 'token',
    pageSize: 100,
};

/**
 * Drives the WALL handler like the crawler would: it keeps feeding the handler
 * the requests it enqueues, so pagination is exercised for real.
 */
const runWall = async ({ config, pages }) => {
    const collector = new ResultCollector({ maxItems: config.maxItems });
    const router = createApiRouter({ collector, config, runState: new RunState() });

    const queue = [{
        label: LABELS.WALL,
        userData: {
            label: LABELS.WALL,
            target: 'test',
            targetType: 'handle',
            offset: 0,
            perTargetPushed: 0,
            ownerId: null,
            domain: 'test',
        },
    }];

    let requestsMade = 0;
    while (queue.length > 0) {
        const request = queue.shift();
        const page = pages(request.userData.offset);
        requestsMade++;

        const enqueued = [];
        await router(
            {
                request,
                body: Buffer.from(JSON.stringify(page)),
                crawler: { addRequests: async (reqs) => enqueued.push(...reqs) },
                sendRequest: vi.fn(),
                log: fakeLog,
            },
            { label: request.userData.label },
        );

        queue.push(...enqueued.map((r) => ({ label: r.userData.label, userData: r.userData })));
        if (requestsMade > 50) throw new Error('Pagination did not terminate.');
    }

    return { collector, requestsMade };
};

/** A wall of `total` posts served 100 at a time. */
const pagedWall = (total) => (offset) => wallPage({
    total,
    startId: offset,
    size: Math.max(0, Math.min(100, total - offset)),
});

beforeEach(() => {
    pushed.length = 0;
});

describe('WALL handler', () => {
    it('paginates until the wall is exhausted', async () => {
        const { collector, requestsMade } = await runWall({
            config: { ...baseConfig },
            pages: pagedWall(250),
        });

        expect(collector.pushed).toBe(250);
        expect(pushed).toHaveLength(250);
        expect(requestsMade).toBe(3);
    });

    it('stops at the global maxItems and never overshoots', async () => {
        const { collector } = await runWall({
            config: { ...baseConfig, maxItems: 120 },
            pages: pagedWall(1000),
        });

        expect(collector.pushed).toBe(120);
        expect(pushed).toHaveLength(120);
    });

    it('honours postsPerTarget', async () => {
        const { collector } = await runWall({
            config: { ...baseConfig, postsPerTarget: 30 },
            pages: pagedWall(1000),
        });

        expect(collector.pushed).toBe(30);
    });

    it('de-duplicates posts VK repeats across pages', async () => {
        // Every page returns the same three posts - a pinned post behaves like this.
        const { collector } = await runWall({
            config: { ...baseConfig, maxItems: 50 },
            pages: () => wallPage({ total: 9, startId: 0, size: 3 }),
        });

        expect(collector.pushed).toBe(3);
        expect(new Set(pushed.map((p) => p.postId)).size).toBe(3);
    });

    it('stops paginating once posts fall before publishedAfter', async () => {
        // Posts walk one day back per ID from 2024-06-01, so 06-01 down to 05-27 survive.
        const { collector, requestsMade } = await runWall({
            config: { ...baseConfig, publishedAfter: new Date(Date.UTC(2024, 4, 27)) },
            pages: pagedWall(1000),
        });

        expect(collector.pushed).toBe(6);
        expect(requestsMade).toBe(1);
        expect(pushed.every((p) => new Date(p.postedAt) >= new Date(Date.UTC(2024, 4, 27)))).toBe(true);
    });

    it('drops posts newer than publishedBefore without stopping the crawl', async () => {
        const { collector } = await runWall({
            config: { ...baseConfig, publishedBefore: new Date(Date.UTC(2024, 4, 30)) },
            pages: pagedWall(10),
        });

        expect(collector.pushed).toBe(8);
        expect(pushed.every((p) => new Date(p.postedAt) <= new Date(Date.UTC(2024, 4, 30)))).toBe(true);
    });

    it('terminates on an empty page even when VK reports a larger count', async () => {
        const { collector } = await runWall({
            config: { ...baseConfig },
            pages: (offset) => wallPage({ total: 9999, startId: offset, size: offset === 0 ? 10 : 0 }),
        });

        expect(collector.pushed).toBe(10);
    });

    it('produces fully-shaped dataset items', async () => {
        await runWall({ config: { ...baseConfig, maxItems: 1 }, pages: pagedWall(10) });

        expect(pushed[0]).toMatchObject({
            postId: '-1_0',
            ownerId: -1,
            text: 'post 0',
            sourceUrl: 'https://vk.com/wall-1_0',
            target: 'test',
            targetType: 'handle',
            stats: { likes: 1, comments: 0, reposts: 0, views: 10, engagement: 1 },
            mediaTypes: [],
            isRepost: false,
        });
        expect(pushed[0].author).toMatchObject({ name: 'Test', url: 'https://vk.com/test' });
        expect(pushed[0].scrapedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('surfaces a VK error instead of pushing anything', async () => {
        const collector = new ResultCollector({ maxItems: 10 });
        const router = createApiRouter({ collector, config: baseConfig, runState: new RunState() });

        await expect(router(
            {
                request: { label: LABELS.WALL, userData: { label: LABELS.WALL, target: 'test', offset: 0, perTargetPushed: 0, domain: 'test' } },
                body: Buffer.from(JSON.stringify({ error: { error_code: 15, error_msg: 'Access denied' } })),
                crawler: { addRequests: vi.fn() },
                sendRequest: vi.fn(),
                log: fakeLog,
            },
            { label: LABELS.WALL },
        )).rejects.toThrow(/Access denied/);

        expect(pushed).toHaveLength(0);
    });

    it('reports a blocked (non-JSON) response clearly', async () => {
        const collector = new ResultCollector({ maxItems: 10 });
        const router = createApiRouter({ collector, config: baseConfig, runState: new RunState() });

        await expect(router(
            {
                request: { label: LABELS.WALL, userData: { label: LABELS.WALL, target: 'test', offset: 0, perTargetPushed: 0, domain: 'test' } },
                body: Buffer.from('<html>blocked</html>'),
                crawler: { addRequests: vi.fn() },
                sendRequest: vi.fn(),
                log: fakeLog,
            },
            { label: LABELS.WALL },
        )).rejects.toThrow(/blocked/);
    });
});

describe('classifyError', () => {
    const build = () => {
        const runState = new RunState();
        const router = createApiRouter({
            collector: new ResultCollector({ maxItems: 1 }), config: baseConfig, runState,
        });
        return { router, runState };
    };

    it('retries transient VK errors', () => {
        const { router } = build();
        expect(router.classifyError(new VkApiError({ error_code: 6 }, 'wall.get'))).toEqual({ retry: true });
    });

    it('skips permanently-denied targets without retrying', () => {
        const { router } = build();
        expect(router.classifyError(new VkApiError({ error_code: 15 }, 'wall.get'))).toEqual({ retry: false });
    });

    it('records a dead token as fatal', () => {
        const { router, runState } = build();
        expect(router.classifyError(new VkApiError({ error_code: 5 }, 'wall.get'))).toEqual({ retry: false, fatal: true });
        expect(runState.fatalError).toBeInstanceOf(VkApiError);
    });

    it('retries unknown (non-VK) errors', () => {
        const { router } = build();
        expect(router.classifyError(new Error('socket hang up'))).toEqual({ retry: true });
    });
});
