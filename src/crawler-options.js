import { log } from 'apify';

/**
 * Crawler option objects, kept out of the entry point so tests can construct the
 * crawlers with them. Crawlee validates its options strictly and throws on an
 * unknown key, so an option in the wrong place is a run-ending error that only
 * surfaces at startup - exactly the kind of mistake a test should catch first.
 */

/** Network-level failures, as opposed to something wrong with the page itself. */
const NAVIGATION_FAILURE = /timeout|ERR_|net::|socket|ECONN|EAI_AGAIN|tunnel|proxy/i;

/** @param {Error} error */
export const isNavigationFailure = (error) => NAVIGATION_FAILURE.test(error?.message ?? '');

/**
 * Swaps between VK's mobile and desktop hosts. When one is unreachable through a
 * given proxy the other frequently still answers, and both render walls this
 * Actor can read.
 * @param {string} url
 */
export const swapVkHost = (url) => (url.includes('//m.vk.com')
    ? url.replace('//m.vk.com', '//vk.com')
    : url.replace('//vk.com', '//m.vk.com'));

/**
 * Options for the official-API crawl.
 * @param {object} deps
 * @param {object} deps.router Cheerio router with `classifyError`.
 * @param {object} [deps.proxyConfiguration]
 */
export const buildApiCrawlerOptions = ({ router, proxyConfiguration }) => ({
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

/**
 * Options for the token-free HTML crawl.
 * @param {object} deps
 * @param {object} deps.router Playwright router.
 * @param {object} deps.config Validated input.
 * @param {object} [deps.proxyConfiguration]
 */
export const buildHtmlCrawlerOptions = ({ router, config, proxyConfiguration }) => ({
    proxyConfiguration,
    requestHandler: router,
    maxConcurrency: 2,
    // Residential proxies rotate through exits of wildly varying quality, and a
    // dead exit costs a full navigation timeout, so budget for several bad draws.
    maxRequestRetries: 8,
    navigationTimeoutSecs: 30,
    requestHandlerTimeoutSecs: 300,
    browserPoolOptions: {
        // Give up on a browser after a handful of pages so a poisoned session and
        // its proxy exit cannot serve the whole run.
        retireBrowserAfterPageCount: 5,
    },
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
            // VK prints post times in the viewer's timezone. Residential proxies exit
            // in a different country each run, so without pinning these the same wall
            // yields differently-shifted timestamps every time.
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
