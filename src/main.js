import { setTimeout as sleep } from 'node:timers/promises';

import { Actor, log } from 'apify';
import { CheerioCrawler } from '@crawlee/cheerio';
import { PlaywrightCrawler } from '@crawlee/playwright';

import { validateInput } from './input.js';
import { ResultCollector } from './results.js';
import { LABELS, createApiRouter } from './routes.js';
import { HTML_LABELS, createHtmlRouter } from './routes-html.js';
import { describeTarget } from './targets.js';
import { buildApiRequest } from './vk-api.js';

await Actor.init();

Actor.on('aborting', async () => {
    log.info('Abort requested - flushing state and shutting down.');
    // Give Crawlee's state persistence a moment before the process goes away.
    await sleep(1_000);
    await Actor.exit();
});

const input = await Actor.getInput();
const { config, targets } = validateInput(input);

const collector = new ResultCollector({ maxItems: config.maxItems });
const runState = { fatalError: null };

const proxyConfiguration = await Actor.createProxyConfiguration(
    // VK blocks most datacenter ranges; residential is the working default.
    input.proxyConfiguration ?? { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
);

if (config.mode === 'api') {
    const router = createApiRouter({ collector, config, runState });

    const crawler = new CheerioCrawler({
        proxyConfiguration,
        requestHandler: router,
        additionalMimeTypes: ['application/json'],
        // VK caps user tokens at ~3 requests/second; one at a time keeps us clear.
        maxConcurrency: 1,
        maxRequestRetries: 5,
        requestHandlerTimeoutSecs: 180,
        errorHandler: ({ request }, error) => {
            const { retry, fatal } = router.classifyError(error);
            if (fatal) {
                log.error(`Fatal VK API error - aborting run: ${error.message}`);
                request.noRetry = true;
                return;
            }
            if (!retry) {
                log.softFail(`Skipping ${request.userData.target}: ${error.message}`);
                request.noRetry = true;
            }
        },
        failedRequestHandler: ({ request }, error) => {
            log.error(`Request for target "${request.userData.target}" failed: ${error.message}`);
        },
    });

    const startRequests = targets.map((target) => {
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
    });

    await crawler.run(startRequests);
} else {
    const router = createHtmlRouter({ collector, config });

    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        requestHandler: router,
        maxConcurrency: 2,
        maxRequestRetries: 3,
        navigationTimeoutSecs: 60,
        requestHandlerTimeoutSecs: 300,
        launchContext: {
            launchOptions: {
                args: ['--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
            },
        },
        failedRequestHandler: ({ request }, error) => {
            log.error(`Wall for "${request.userData.target}" could not be scraped: ${error.message}`);
        },
    });

    const startRequests = targets
        .filter((target) => {
            if (target.kind === 'post') {
                log.warning(
                    `Single-post target "${describeTarget(target)}" needs API mode - supply an "accessToken". Skipping.`,
                );
                return false;
            }
            return true;
        })
        .map((target) => ({
            url: target.domain
                ? `https://m.vk.com/${target.domain}`
                : `https://m.vk.com/wall${target.ownerId}`,
            label: HTML_LABELS.WALL,
            userData: { label: HTML_LABELS.WALL, target: target.raw, targetType: target.targetType },
        }));

    if (startRequests.length === 0) {
        throw new Error('Every target requires API mode. Supply an "accessToken" in the input.');
    }

    await crawler.run(startRequests);
}

if (runState.fatalError) {
    await Actor.fail(
        `VK rejected the access token: ${runState.fatalError.message}. `
        + 'Generate a fresh token with "wall" scope and try again.',
    );
}

if (collector.pushed === 0) {
    // An empty dataset is almost always a misconfiguration, not a real result.
    await Actor.fail(
        'No posts were extracted. Check that the targets exist and are publicly readable, '
        + 'that the date filters are not excluding everything, and that the proxy is not blocked by VK.',
    );
}

log.info(`Done. Extracted ${collector.pushed} post(s) from ${targets.length} target(s).`);
await Actor.exit();
