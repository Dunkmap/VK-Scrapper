import { createPlaywrightRouter } from '@crawlee/playwright';
import { log } from 'apify';

import { parseVkDateLabel } from './vk-date-label.js';

/**
 * Best-effort DOM scraping of the VK mobile wall, used when no access token is
 * supplied.
 *
 * This mode is deliberately limited and honest about it: VK's public HTML
 * exposes far less than the API (no view counts on many posts, no attachment
 * URLs beyond thumbnails, relative dates that cannot always be resolved to a
 * timestamp). Fields VK does not expose are emitted as `null` - never guessed.
 */

export const HTML_LABELS = { WALL: 'HTML_WALL' };

/** How many "load more" scroll rounds before giving up on a wall. */
const MAX_SCROLL_ROUNDS = 40;

/** Consecutive rounds that add no posts before we call the wall finished. */
const BARREN_ROUNDS_BEFORE_STOP = 2;

/**
 * Total time allowed for scrolling one wall. Anonymous VK stops serving posts
 * after a handful, so without a ceiling the loop spends minutes confirming a
 * limit it hit in the first few seconds.
 */
const SCROLL_BUDGET_MS = 45_000;

/** How long to wait for a scroll to produce new posts before treating it as barren. */
const SETTLE_TIMEOUT_MS = 3_000;

/** VK's "show more posts" control, across markup generations. */
const SHOW_MORE_SELECTOR = '.show_more_wrap a, ._wall_more_link, .wall_more_link, .ui_show_more';

/**
 * How many offset pages to follow per target. VK's mobile wall paginates by URL
 * (`/wall-123?offset=40`), which reaches much further than scrolling one page.
 */
const MAX_WALL_PAGES = 25;

/** Every markup generation VK has served a wall post in. */
export const POST_SELECTOR = '[data-post-id], .wall_item, ._post, .post';

/**
 * The wall itself. VK surrounds it with recommendation rails and "interesting
 * pages" blocks that use the same post markup but belong to other communities,
 * so the search has to be scoped to this subtree.
 */
export const WALL_ROOT_SELECTOR = '#wall_posts, .wall_posts, ._wall_posts, #page_wall_posts,'
    + ' #wl_posts, .wall_module, [id^="page_wall_posts"]';

/**
 * Runs in the browser: reads every wall post currently in the DOM.
 * Kept dependency-free because it is serialized into the page context.
 * Exported so it can be exercised against fixture markup in tests.
 */
export const extractPostsInPage = ({ postSelector, wallRootSelector }) => {
    /** Buttons and badges VK renders *inside* the text node, e.g. "Show more". */
    const TEXT_CHROME = '.wall_post_more, .PostTextMore, .js-wall_post_more, .wall_post_text_more,'
        + ' .PostText__more, .show_more, .more_link';

    /**
     * Reads an element's text with VK's inline UI chrome removed. The node is
     * cloned so the live page is never mutated.
     * @param {Element} root @param {string[]} selectors
     */
    const firstText = (root, selectors) => {
        for (const selector of selectors) {
            const node = root.querySelector(selector);
            if (!node) continue;
            const clone = node.cloneNode(true);
            for (const chrome of clone.querySelectorAll(TEXT_CHROME)) chrome.remove();
            const text = clone.textContent?.replace(/\s+\n/g, '\n').trim();
            if (text) return text;
        }
        return null;
    };

    /**
     * VK writes counters either exactly ("1 234") or abbreviated ("1,2K", "1,2 тыс.",
     * "3.4M", "5 млн"). Abbreviated values are rounded by VK, so they are returned
     * with `isApproximate` set rather than being passed off as exact.
     *
     * @returns {{value: number, isApproximate: boolean}|null}
     */
    const parseCounter = (raw) => {
        if (!raw) return null;

        // Strip spacing, including the non-breaking space VK uses as a thousands separator.
        const cleaned = [...raw].filter((char) => char.trim().length > 0).join('');
        if (cleaned === '') return null;
        if (/^\d+$/.test(cleaned)) return { value: Number(cleaned), isApproximate: false };

        const match = /^(\d+(?:[.,]\d+)?)(k|к|тыс|m|м|млн|b|млрд)\.?$/i.exec(cleaned);
        if (!match) return null;

        const magnitude = {
            k: 1e3, к: 1e3, тыс: 1e3, m: 1e6, м: 1e6, млн: 1e6, b: 1e9, млрд: 1e9,
        }[match[2].toLowerCase()];
        if (!magnitude) return null;

        // A comma is a decimal separator in the Russian interface.
        const amount = Number(match[1].replace(',', '.'));
        if (!Number.isFinite(amount)) return null;

        return { value: Math.round(amount * magnitude), isApproximate: true };
    };

    // Prefer the wall subtree; fall back to the whole document only if VK's
    // markup has moved and scoping would otherwise find nothing.
    const wallRoot = document.querySelector(wallRootSelector);
    const scoped = wallRoot ? wallRoot.querySelectorAll(postSelector) : [];
    const containers = scoped.length > 0 ? scoped : document.querySelectorAll(postSelector);
    const wasScoped = scoped.length > 0;

    // VK renders the same post more than once - a pinned post repeats further down
    // the wall, and some layouts nest a wrapper around the post body. Keyed by ID so
    // the caller sees each post once, keeping whichever copy carries the most data.
    const byId = new Map();
    const richness = (post) => (post.text?.length ?? 0)
        + post.thumbnails.length * 50
        + (post.postedAtUnix || post.postedAtText ? 100 : 0);

    for (const container of containers) {
        const html = container.innerHTML ?? '';
        const idAttr = container.getAttribute('data-post-id') ?? '';
        const idMatch = /(-?\d+)_(\d+)/.exec(idAttr)
            || /wall(-?\d+)_(\d+)/.exec(container.querySelector('a[href*="wall"]')?.getAttribute('href') ?? '')
            || /wall(-?\d+)_(\d+)/.exec(html);
        if (!idMatch) continue;

        const ownerId = Number(idMatch[1]);
        const postId = Number(idMatch[2]);

        // VK sometimes stamps an absolute unix time on the date element; when it
        // does not, the printed label is the only date available. Markup varies by
        // generation, so cast a wide net and fall back to any link pointing at
        // this very post - VK renders the date as that link's text.
        const dateNode = container.querySelector(
            'time, [data-time], [unixtime], [abs_time], .pi_date, .rel_date, .PostHeaderSubtitle__item,'
            + ' .post_date, .rel_date_needs_update, .PostHeaderSubtitle__separator ~ *',
        ) ?? container.querySelector(`a[href*="wall${ownerId}_${postId}"]`);

        const dateLink = container.querySelector(
            `.PostHeaderSubtitle__link, .post_link, a.pi_date, a[href*="wall${ownerId}_${postId}"]`,
        );

        const readNumericAttr = (node) => {
            for (const attr of ['time', 'data-time', 'unixtime', 'abs_time', 'datetime']) {
                const value = Number(node?.getAttribute?.(attr));
                if (Number.isFinite(value) && value > 0) return value;
            }
            return NaN;
        };
        // The timestamp may sit on the date node itself or on a child span.
        const unix = [dateNode, dateLink, ...container.querySelectorAll('[time], [data-time], [unixtime], [abs_time]')]
            .map(readNumericAttr)
            .find((value) => Number.isFinite(value) && value > 0) ?? NaN;

        // Media thumbnails only - emoji, avatars and UI sprites are not attachments.
        const isContentImage = (src) => src
            && !src.startsWith('data:')
            && !/\/emoji\//i.test(src)
            && !/\/images\/(icons|stickers)?/i.test(src)
            && !/\.svg(\?|$)/i.test(src)
            && !/\/(css|js)\//i.test(src);

        const thumbnails = [...new Set(
            [...container.querySelectorAll('img')]
                .map((img) => img.getAttribute('src') || img.getAttribute('data-src'))
                .filter(isContentImage)
                // Resolve protocol-relative and root-relative URLs against the page.
                .map((src) => new URL(src, document.baseURI).href),
        )];

        // Attachment links carry the VK object each piece of media points at, which is
        // far more useful than a thumbnail: photo/video/doc pages can be opened or
        // resolved further, whereas a CDN thumbnail expires.
        const ATTACHMENT_PATTERNS = [
            { type: 'photo', pattern: /\/photo(-?\d+_\d+)/ },
            { type: 'video', pattern: /\/video(-?\d+_\d+)/ },
            { type: 'audio', pattern: /\/audio(-?\d+_\d+)/ },
            { type: 'doc', pattern: /\/doc(-?\d+_\d+)/ },
            { type: 'article', pattern: /\/@[\w.]+-/ },
            { type: 'link', pattern: /\/away\.php\?to=/ },
        ];

        const attachments = [];
        const seenAttachments = new Set();
        for (const anchor of container.querySelectorAll('a[href]')) {
            const href = anchor.getAttribute('href') ?? '';
            for (const { type, pattern } of ATTACHMENT_PATTERNS) {
                const hit = pattern.exec(href);
                if (!hit) continue;

                const absolute = new URL(href, document.baseURI).href;
                const key = `${type}:${hit[1] ?? absolute}`;
                if (seenAttachments.has(key)) break;
                seenAttachments.add(key);

                attachments.push({
                    type,
                    id: hit[1] ?? null,
                    url: type === 'link'
                        // VK wraps outbound links; recover the real destination.
                        ? decodeURIComponent(new URL(absolute).searchParams.get('to') ?? absolute)
                        : absolute,
                });
                break;
            }
        }

        const mediaTypes = [...new Set(attachments.map((a) => a.type))];
        if (container.querySelector('.PollQuestion, .poll_board')) mediaTypes.push('poll');
        // A thumbnail with no recognised link is still media - report it rather than lose it.
        if (mediaTypes.length === 0 && thumbnails.length > 0) mediaTypes.push('photo');

        const post = {
            ownerId,
            postId,
            text: firstText(container, ['.pi_text', '.wall_post_text', '.PostText', '.post_info .wall_post_text']) ?? '',
            postedAtUnix: Number.isFinite(unix) && unix > 0 ? unix : null,
            // VK hides the full date in a `title` tooltip and prints a short label.
            postedAtText: dateLink?.getAttribute('title')?.trim()
                || dateNode?.getAttribute('title')?.trim()
                || dateLink?.textContent?.trim()
                || dateNode?.textContent?.trim()
                || null,
            // Kept only when the date could not be read, so a failing selector can
            // be diagnosed from the run log instead of guessed at.
            headerSample: (dateNode || dateLink)
                ? null
                : container.innerHTML.slice(0, 400).replace(/\s+/g, ' '),
            likes: parseCounter(firstText(container, [
                '.PostBottomAction--like .PostBottomAction__count', '._like_count', '.v_like',
                '[class*="like"] [class*="count"]', '.PostButtonReactions__title',
            ])),
            comments: parseCounter(firstText(container, [
                '.PostBottomAction--comment .PostBottomAction__count', '._comments_count', '.v_comments',
                '[class*="comment"] [class*="count"]',
            ])),
            reposts: parseCounter(firstText(container, [
                '.PostBottomAction--share .PostBottomAction__count', '._share_count', '.v_share',
                '[class*="share"] [class*="count"]',
            ])),
            views: parseCounter(firstText(container, [
                '.PostBottomAction--views .PostBottomAction__count', '._views_count', '.v_views',
                '[class*="views"] [class*="count"]', '.PostBottomAction__count--views',
            ])),
            isPinned: !!container.querySelector('.PostHeaderSubtitle__item--pinned, .wi_fixed'),
            isRepost: !!container.querySelector('.copy_quote, .PostCopyQuote, .wi_copy'),
            thumbnails,
            attachments,
            mediaTypes,
        };

        const key = `${ownerId}_${postId}`;
        const existing = byId.get(key);
        if (!existing || richness(post) > richness(existing)) byId.set(key, post);
    }

    return { posts: [...byId.values()], wasScoped };
};

/**
 * Turns the raw counters into the dataset's `stats` block.
 *
 * VK abbreviates large numbers ("1,2 тыс."), and those are rounded at the source.
 * `areApproximate` says so explicitly rather than letting a rounded figure pass
 * for an exact one.
 *
 * @param {object} raw Post as returned from the page.
 */
const countersToStats = (raw) => {
    const read = (counter) => counter?.value ?? null;
    const likes = read(raw.likes);
    const comments = read(raw.comments);
    const reposts = read(raw.reposts);
    const views = read(raw.views);

    return {
        likes,
        comments,
        reposts,
        views,
        engagement: [likes, comments, reposts].some((value) => value !== null)
            ? (likes ?? 0) + (comments ?? 0) + (reposts ?? 0)
            : null,
        areApproximate: [raw.likes, raw.comments, raw.reposts, raw.views]
            .some((counter) => counter?.isApproximate === true),
    };
};

/**
 * The value appearing most often, used to infer a wall's owner when the target
 * was given as a handle rather than a numeric ID.
 * @param {number[]} values
 * @returns {number|null}
 */
const mostCommon = (values) => {
    const tally = new Map();
    for (const value of values) tally.set(value, (tally.get(value) ?? 0) + 1);

    let winner = null;
    let best = 0;
    for (const [value, count] of tally) {
        if (count > best) {
            winner = value;
            best = count;
        }
    }
    return winner;
};

/**
 * @param {object} context
 * @param {import('./results.js').ResultCollector} context.collector
 * @param {object} context.config
 * @returns {import('@crawlee/playwright').PlaywrightRouter}
 */
export const createHtmlRouter = ({ collector, config }) => {
    const router = createPlaywrightRouter();

    router.addHandler(HTML_LABELS.WALL, async ({ page, request, crawler }) => {
        const {
            target, targetType, ownerId, offset = 0, storedSoFar = 0, pageIndex = 0,
        } = request.userData;

        const perTargetLimit = config.postsPerTarget ?? Number.POSITIVE_INFINITY;
        // This page only needs to cover what earlier offsets did not.
        const wanted = Math.min(perTargetLimit - storedSoFar, collector.remaining);

        await page.waitForSelector(POST_SELECTOR, { timeout: 20_000 })
            .catch(() => {
                throw new Error(
                    `No wall posts rendered for "${target}". The wall is private, empty, or VK served a login wall. `
                    + 'Supply an "accessToken" to use the official API instead.',
                );
            });

        // Count only posts inside the wall. Counting the whole document includes
        // recommendation rails, which made the loop believe it already had enough
        // and stop scrolling before the wall itself had loaded.
        const countPosts = () => page
            .evaluate(({ postSelector, wallRootSelector }) => {
                const root = document.querySelector(wallRootSelector);
                return (root ?? document).querySelectorAll(postSelector).length;
            }, { postSelector: POST_SELECTOR, wallRootSelector: WALL_ROOT_SELECTOR })
            .catch(() => 0);

        // Scroll until VK stops adding posts, we have enough, or the budget runs out.
        // Each round waits for the count to actually change rather than sleeping a
        // fixed interval, so a wall that is done is detected in seconds, not minutes.
        const deadline = Date.now() + SCROLL_BUDGET_MS;
        let seenCount = await countPosts();
        let barrenRounds = 0;

        for (let round = 0; round < MAX_SCROLL_ROUNDS && seenCount < wanted; round++) {
            if (Date.now() > deadline) {
                log.info(`[${target}] Scroll budget spent after ${seenCount} post(s); collecting what loaded.`);
                break;
            }

            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

            // Only click "show more" if it is actually there - a locator timeout on a
            // button that does not exist costs seconds on every single round.
            const moreButton = await page.$(SHOW_MORE_SELECTOR);
            if (moreButton) await moreButton.click({ timeout: 2_000 }).catch(() => {});

            // Resolves the moment new posts appear; falls through quickly if none do.
            await page
                .waitForFunction(
                    ([selector, previous]) => document.querySelectorAll(selector).length > previous,
                    [POST_SELECTOR, seenCount],
                    { timeout: SETTLE_TIMEOUT_MS, polling: 250 },
                )
                .catch(() => {});

            const count = await countPosts();
            barrenRounds = count === seenCount ? barrenRounds + 1 : 0;
            seenCount = count;

            if (barrenRounds >= BARREN_ROUNDS_BEFORE_STOP) {
                log.info(`[${target}] VK stopped loading posts after ${count} - treating that as the end of the wall.`);
                break;
            }
        }

        const { posts: extracted, wasScoped } = await page.evaluate(extractPostsInPage, {
            postSelector: POST_SELECTOR,
            wallRootSelector: WALL_ROOT_SELECTOR,
        });
        if (extracted.length === 0) {
            throw new Error(`Wall for "${target}" rendered but no posts could be parsed - VK markup may have changed.`);
        }
        if (!wasScoped) {
            log.warning(
                `[${target}] Could not find the wall container, so the whole page was searched. `
                + 'Posts from recommendation blocks are filtered out by owner, but coverage may be uneven.',
            );
        }

        // Every post on a wall carries that wall's owner ID. Anything else came from
        // a recommendation rail and does not belong in the results for this target.
        const expectedOwnerId = ownerId ?? mostCommon(extracted.map((post) => post.ownerId));
        const rawPosts = extracted.filter((post) => post.ownerId === expectedOwnerId);
        const foreignCount = extracted.length - rawPosts.length;

        if (foreignCount > 0) {
            log.info(
                `[${target}] Ignored ${foreignCount} post(s) belonging to other communities `
                + `(kept owner ${expectedOwnerId}).`,
            );
        }
        if (rawPosts.length === 0) {
            throw new Error(
                `Every post found for "${target}" belonged to a different community. `
                + 'VK likely served a recommendation page instead of the wall.',
            );
        }

        const scrapedAt = new Date().toISOString();
        const hasDateFilter = Boolean(config.publishedAfter || config.publishedBefore);
        const items = [];
        let missingDates = 0;
        let droppedUndated = 0;
        let unreadableSample = null;
        let unreadableLabel = null;

        // How many posts of this page were actually dealt with. The next offset must
        // advance by this and not by the page size: stopping at the budget and then
        // skipping ahead by the whole page steps over every post after the break.
        let consumed = 0;

        for (const raw of rawPosts) {
            consumed++;
            const compositeId = `${raw.ownerId}_${raw.postId}`;

            // Prefer a real timestamp; fall back to parsing the label VK printed.
            // The browser's timezone is pinned to `htmlTimezone`, so VK renders clock
            // times in that zone and the parser can resolve them to exact instants.
            const parsedLabel = raw.postedAtUnix
                ? null
                : parseVkDateLabel(raw.postedAtText, { timeZone: config.htmlTimezone });
            const postedAt = raw.postedAtUnix
                ? new Date(raw.postedAtUnix * 1000).toISOString()
                : parsedLabel?.iso ?? null;

            if (!postedAt) {
                missingDates++;
                if (unreadableSample === null && raw.headerSample) unreadableSample = raw.headerSample;
                if (unreadableLabel === null && raw.postedAtText) unreadableLabel = raw.postedAtText;

                // An undated post cannot be checked against a date filter. Dropping it
                // keeps the filter honest, but the user can opt to keep it instead.
                if (hasDateFilter && !config.keepUndatedPosts) {
                    droppedUndated++;
                    continue;
                }
            } else {
                const date = new Date(postedAt);
                if (config.publishedAfter && date < config.publishedAfter) continue;
                if (config.publishedBefore && date > config.publishedBefore) continue;
            }

            items.push({
                postId: compositeId,
                ownerId: raw.ownerId,
                authorId: null,
                author: null,
                wallOwner: null,

                text: raw.text,
                postedAt,
                postedAtLabel: raw.postedAtText,
                editedAt: null,
                sourceUrl: `https://vk.com/wall${compositeId}`,

                stats: countersToStats(raw),

                mediaTypes: raw.mediaTypes,
                mediaCount: raw.attachments.length || raw.thumbnails.length,
                attachments: [
                    ...raw.attachments,
                    // Thumbnails are kept as a fallback for media VK did not link.
                    ...raw.thumbnails.map((url) => ({ type: 'thumbnail', id: null, url })),
                ],

                isRepost: raw.isRepost,
                repostChain: [],
                isPinned: raw.isPinned,

                target,
                targetType,
                scrapedAt,
                extractionMode: 'html',
            });

            if (items.length >= wanted) break;
        }

        if (missingDates > 0) {
            log.warning(
                `[${target}] ${missingDates} of ${rawPosts.length} post(s) had no readable date, so "postedAt" is null. `
                + 'Use an access token for exact timestamps.',
            );
            // Say which half of the pipeline failed: finding the label, or parsing it.
            if (unreadableLabel !== null) {
                log.warning(`[${target}] A date label was found but not understood: "${unreadableLabel}".`);
            } else if (unreadableSample !== null) {
                log.warning(`[${target}] No date element matched. Post markup starts: ${unreadableSample}`);
            }
        }
        if (droppedUndated > 0) {
            log.warning(
                `[${target}] Dropped ${droppedUndated} undated post(s): a date filter is set and they cannot be `
                + 'checked against it. Clear "publishedAfter"/"publishedBefore", or set "keepUndatedPosts" to keep them.',
            );
        }

        const stored = await collector.push(items);
        const totalStored = storedSoFar + stored;

        // VK's mobile wall paginates by URL offset, which reaches far deeper than
        // scrolling one rendered page. Follow it while posts keep arriving.
        const needMore = totalStored < Math.min(perTargetLimit, config.maxItems)
            && !collector.isFull
            && stored > 0
            && pageIndex < MAX_WALL_PAGES;

        if (needMore) {
            const nextOffset = offset + consumed;
            // Stay on whichever host answered; a desktop fallback must not bounce back.
            const { origin } = new URL(request.url);
            log.info(`[${target}] Stored ${totalStored} so far; requesting wall offset ${nextOffset}.`);
            await crawler.addRequests([{
                url: `${origin}/wall${expectedOwnerId}?offset=${nextOffset}`,
                label: HTML_LABELS.WALL,
                uniqueKey: `html-wall:${expectedOwnerId}:${nextOffset}`,
                userData: {
                    label: HTML_LABELS.WALL,
                    target,
                    targetType,
                    ownerId: expectedOwnerId,
                    offset: nextOffset,
                    storedSoFar: totalStored,
                    pageIndex: pageIndex + 1,
                },
            }]);
            return;
        }

        // Only report a shortfall once the crawl for this target is actually over.
        if (totalStored < wanted && Number.isFinite(wanted)) {
            // Distinguish "VK would not serve more" from "we parsed fewer than we saw",
            // because only the second one is something this Actor can fix.
            const sawEnough = rawPosts.length >= wanted;
            log.warning(
                sawEnough
                    ? `[${target}] Found ${rawPosts.length} post(s) but stored only ${totalStored} - the rest were `
                        + 'filtered out by your date range or could not be parsed.'
                    : `[${target}] VK stopped serving posts after ${totalStored}. Anonymous access to a wall is `
                        + 'capped, so the public HTML does not contain more. An "accessToken" lifts this - the '
                        + 'API returns the entire wall.',
            );
        }
    });

    return router;
};
