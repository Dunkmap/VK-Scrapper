import { setTimeout as sleep } from 'node:timers/promises';

import { CheerioCrawler } from '@crawlee/cheerio';
import { PlaywrightCrawler } from '@crawlee/playwright';
import { Actor, log } from 'apify';

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

    const crawler = new CheerioCrawler({
        proxyConfiguration,
        requestHandler: router,
        additionalMimeTypes: ['application/json'],
        // VK caps user tokens at roughly 3 requests/second; one at a time keeps us clear.
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
                log.softFail(`Skipping "${request.userData.target}": ${error.message}`);
                request.noRetry = true;
            }
        },
        failedRequestHandler: ({ request }, error) => {
            log.error(`Request for target "${request.userData.target}" failed: ${error.message}`);
        },
    });

    await crawler.run(targets.map((target) => buildStartRequest(target, config)));
};

/** Network-level failures, as opposed to something wrong with the page itself. */
const NAVIGATION_FAILURE = /timeout|ERR_|net::|socket|ECONN|EAI_AGAIN|tunnel|proxy/i;

/** @param {Error} error */
const isNavigationFailure = (error) => NAVIGATION_FAILURE.test(error?.message ?? '');

/**
 * Swaps between VK's mobile and desktop hosts. When one is unreachable through a
 * given proxy the other frequently still answers, and both render walls this
 * Actor can read.
 * @param {string} url
 */
const swapVkHost = (url) => (url.includes('//m.vk.com')
    ? url.replace('//m.vk.com', '//vk.com')
    : url.replace('//vk.com', '//m.vk.com'));

/** Runs the token-free mobile-HTML crawl. */
const runHtmlCrawl = async ({ config, targets, collector, proxyConfiguration }) => {
    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        requestHandler: createHtmlRouter({ collector, config }),
        maxConcurrency: 2,
        // Residential proxies rotate through exits of wildly varying quality, and a
        // dead exit costs a full navigation timeout, so budget for several bad draws.
        maxRequestRetries: 8,
        navigationTimeoutSecs: 30,
        requestHandlerTimeoutSecs: 300,
        // Give up on a browser after a handful of pages so a poisoned session and
        // its proxy exit cannot serve the whole run.
        retireBrowserAfterPageCount: 5,
        preNavigationHooks: [
            async (_ctx, gotoOptions) => {
                // VK holds sockets open for polling, so "load" never fires and every
                // navigation burns the full timeout before succeeding anyway.
                // Crawlee's hook contract is to mutate this object in place.
                // eslint-disable-next-line no-param-reassign
                gotoOptions.waitUntil = 'domcontentloaded';
            },
        ],
        launchContext: {
            launchOptions: {
                args: ['--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
                // VK prints post times in the viewer's timezone. Residential proxies
                // exit in a different country each run, so without pinning these the
                // same wall yields differently-shifted timestamps every time.
                timezoneId: config.htmlTimezone,
                locale: 'ru-RU',
            },
        },
        errorHandler: ({ request, session }, error) => {
            // A navigation failure means the proxy exit is bad, not the page. Burn the
            // session so the retry draws a different IP instead of the same dead one.
            if (isNavigationFailure(error)) {
                session?.retire();
                const swapped = swapVkHost(request.url);
                if (swapped !== request.url && request.retryCount >= 2) {
                    log.warning(`Mobile VK is not responding; retrying "${request.userData.target}" on ${swapped}.`);
                    request.url = swapped;
                }
            }
        },
        failedRequestHandler: ({ request }, error) => {
            log.error(
                `Wall for "${request.userData.target}" could not be scraped after ${request.retryCount} attempts: `
                + `${error.message}`,
            );
        },
    });

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
