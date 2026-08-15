import { setTimeout as sleep } from 'node:timers/promises';

import { CheerioCrawler } from '@crawlee/cheerio';
import { PlaywrightCrawler } from '@crawlee/playwright';
import { Actor, log } from 'apify';

import { buildApiCrawlerOptions, buildHtmlCrawlerOptions } from './crawler-options.js';
import { validateInput } from './input.js';
import { ResultCollector } from './results.js';
import { createApiRouter, LABELS } from './routes.js';
import { createHtmlRouter, HTML_LABELS } from './routes-html.js';
import { RunState } from './run-state.js';
import { describeTarget } from './targets.js';
import { buildApiRequest } from './vk-api.js';

await Actor.init();

Actor.on('aborting', async () => {
    log.info('Abort requested - flushing state and shutting down.');
    // Give Crawlee's state persistence a moment before the process goes away.
    await sleep(1_000);
    await Actor.exit();
});

/**
 * Turns one parsed target into its first VK API request.
 * @param {ReturnType<import('./targets.js').parseTarget>} target
 * @param {object} config
 */
const buildStartRequest = (target, config) => {
    const label = target.kind === 'post' ? LABELS.POST : LABELS.WALL;
    const userData = {
        label,
        target: target.raw,
        targetType: target.targetType,
        offset: 0,
        perTargetPushed: 0,
        ownerId: target.ownerId ?? null,
        domain: target.domain ?? null,
    };

    if (target.kind === 'post') {
        return buildApiRequest(
            'wall.getById',
            { posts: `${target.ownerId}_${target.postId}`, extended: 1, copy_history_depth: 5 },
            config.accessToken,
            userData,
            `post:${target.ownerId}_${target.postId}`,
        );
    }

    return buildApiRequest(
        'wall.get',
        {
            ...(target.domain ? { domain: target.domain } : { owner_id: target.ownerId }),
            offset: 0,
            count: config.pageSize,
            extended: 1,
            filter: config.postFilter,
            fields: 'screen_name,photo_200,verified,members_count',
        },
        config.accessToken,
        userData,
        `wall:${target.domain ?? target.ownerId}:0`,
    );
};

/** Runs the official-API crawl. */
const runApiCrawl = async ({ config, targets, collector, runState, proxyConfiguration }) => {
    const router = createApiRouter({ collector, config, runState });

    const crawler = new CheerioCrawler(buildApiCrawlerOptions({ router, proxyConfiguration }));

    await crawler.run(targets.map((target) => buildStartRequest(target, config)));
};

/** Runs the token-free mobile-HTML crawl. */
const runHtmlCrawl = async ({ config, targets, collector, proxyConfiguration }) => {
    const crawler = new PlaywrightCrawler(buildHtmlCrawlerOptions({
        router: createHtmlRouter({ collector, config }),
        config,
        proxyConfiguration,
    }));

    const startRequests = targets
        .filter((target) => {
            if (target.kind !== 'post') return true;
            log.warning(
                `Single-post target "${describeTarget(target)}" needs API mode - supply an "accessToken". Skipping.`,
            );
            return false;
        })
        .map((target) => ({
            url: target.domain
                ? `https://m.vk.com/${target.domain}`
                : `https://m.vk.com/wall${target.ownerId}`,
            label: HTML_LABELS.WALL,
            userData: {
                label: HTML_LABELS.WALL,
                target: target.raw,
                targetType: target.targetType,
                // Known only for numeric/club targets; otherwise inferred from the page.
                ownerId: target.ownerId ?? null,
            },
        }));

    if (startRequests.length === 0) {
        throw new Error('Every supplied target requires API mode. Add an "accessToken" to the input.');
    }

    await crawler.run(startRequests);
};

try {
    const input = await Actor.getInput();
    const { config, targets } = validateInput(input);

    const collector = new ResultCollector({ maxItems: config.maxItems });
    const runState = new RunState();
    const proxyConfiguration = await Actor.createProxyConfiguration(
        // VK blocks most datacenter ranges, so residential is the working default.
        input.proxyConfiguration ?? { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
    );

    const crawlOptions = { config, targets, collector, runState, proxyConfiguration };
    if (config.mode === 'api') {
        await runApiCrawl(crawlOptions);
    } else {
        await runHtmlCrawl(crawlOptions);
    }

    if (runState.fatalError) {
        await Actor.fail(
            `VK rejected the access token: ${runState.fatalError.message}. `
            + 'Generate a fresh token with the "wall" scope and try again.',
        );
    }

    if (collector.pushed === 0) {
        // An empty dataset is almost always a misconfiguration, not a real result.
        await Actor.fail(
            'No posts were extracted. Check that the targets exist and are publicly readable, '
            + 'that the date filters are not excluding everything, and that VK is not blocking the proxy.',
        );
    }

    log.info(`Done. Extracted ${collector.pushed} post(s) from ${targets.length} target(s).`);
    await Actor.exit();
} catch (error) {
    // Surface a readable reason in the Apify console instead of a raw stack trace.
    log.exception(error, 'The run could not be completed.');
    await Actor.fail(error.message);
}
