import { createPlaywrightRouter } from '@crawlee/playwright';
import { log } from 'apify';

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
const BARREN_ROUNDS_BEFORE_STOP = 3;

/** Every markup generation VK has served a wall post in. */
const POST_SELECTOR = '[data-post-id], .wall_item, ._post, .post';

/**
 * Runs in the browser: reads every wall post currently in the DOM.
 * Kept dependency-free because it is serialized into the page context.
 */
const extractPostsInPage = () => {
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

    /** VK renders counters as "1.2K"/"1,2 тыс." - only trust plain integers. */
    const parseCounter = (raw) => {
        if (!raw) return null;
        // Strip spacing, including the non-breaking space VK uses as a thousands separator.
        const cleaned = [...raw].filter((char) => char.trim().length > 0).join('');
        if (/^\d+$/.test(cleaned)) return Number(cleaned);
        return null;
    };

    const containers = document.querySelectorAll('[data-post-id], .wall_item, ._post, .post');
    const results = [];

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
        // does not, the printed label is the only date available.
        const dateNode = container.querySelector(
            'time, [data-time], .pi_date, .rel_date, .PostHeaderSubtitle__item, .post_date, .rel_date_needs_update',
        );
        const dateLink = container.querySelector('.PostHeaderSubtitle__link, .post_link, a.pi_date');
        const unix = Number(
            dateNode?.getAttribute?.('time')
            ?? dateNode?.getAttribute?.('data-time')
            ?? dateNode?.getAttribute?.('unixtime')
            ?? dateNode?.getAttribute?.('datetime')
            ?? NaN,
        );

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

        const mediaTypes = [];
        if (container.querySelector('a[href*="/photo"], .PhotoPrimaryAttachment, .page_post_sized_thumbs')) mediaTypes.push('photo');
        if (container.querySelector('a[href*="/video"], .post_video_desc, .VideoSnippet')) mediaTypes.push('video');
        if (container.querySelector('a[href*="/audio"], .audio_row')) mediaTypes.push('audio');
        if (container.querySelector('a[href*="/doc"], .page_doc_row')) mediaTypes.push('doc');
        if (container.querySelector('.PollQuestion, .poll_board')) mediaTypes.push('poll');
        // A thumbnail with no recognised container is still media - report it rather than lose it.
        if (mediaTypes.length === 0 && thumbnails.length > 0) mediaTypes.push('photo');

        results.push({
            ownerId,
            postId,
            text: firstText(container, ['.pi_text', '.wall_post_text', '.PostText', '.post_info .wall_post_text']) ?? '',
            postedAtUnix: Number.isFinite(unix) && unix > 0 ? unix : null,
            // VK hides the full date in a `title` tooltip and prints a short label.
            postedAtText: dateLink?.getAttribute('title')?.trim()
                || dateNode?.getAttribute('title')?.trim()
                || dateNode?.textContent?.trim()
                || null,
            likes: parseCounter(firstText(container, ['.PostBottomAction--like .PostBottomAction__count', '._like_count', '.v_like'])),
            comments: parseCounter(firstText(container, ['.PostBottomAction--comment .PostBottomAction__count', '._comments_count', '.v_comments'])),
            reposts: parseCounter(firstText(container, ['.PostBottomAction--share .PostBottomAction__count', '._share_count', '.v_share'])),
            views: parseCounter(firstText(container, ['.PostBottomAction--views .PostBottomAction__count', '._views_count', '.v_views'])),
            isPinned: !!container.querySelector('.PostHeaderSubtitle__item--pinned, .wi_fixed'),
            isRepost: !!container.querySelector('.copy_quote, .PostCopyQuote, .wi_copy'),
            thumbnails,
            mediaTypes,
        });
    }

    return results;
};

/**
 * @param {object} context
 * @param {import('./results.js').ResultCollector} context.collector
 * @param {object} context.config
 * @returns {import('@crawlee/playwright').PlaywrightRouter}
 */
export const createHtmlRouter = ({ collector, config }) => {
    const router = createPlaywrightRouter();

    router.addHandler(HTML_LABELS.WALL, async ({ page, request }) => {
        const { target, targetType } = request.userData;

        const perTargetLimit = config.postsPerTarget ?? Number.POSITIVE_INFINITY;
        const wanted = Math.min(perTargetLimit, collector.remaining);

        await page.waitForSelector(POST_SELECTOR, { timeout: 20_000 })
            .catch(() => {
                throw new Error(
                    `No wall posts rendered for "${target}". The wall is private, empty, or VK served a login wall. `
                    + 'Supply an "accessToken" to use the official API instead.',
                );
            });

        // Scroll until VK stops adding posts or we have enough. VK loads lazily and
        // often pauses for a beat, so one barren round is not the end of the wall -
        // only several in a row are.
        let seenCount = 0;
        let barrenRounds = 0;
        for (let round = 0; round < MAX_SCROLL_ROUNDS; round++) {
            const count = await page
                .evaluate((selector) => document.querySelectorAll(selector).length, POST_SELECTOR)
                .catch(() => 0);
            if (count >= wanted) break;

            barrenRounds = count === seenCount ? barrenRounds + 1 : 0;
            if (barrenRounds >= BARREN_ROUNDS_BEFORE_STOP) {
                log.info(`[${target}] VK stopped loading posts after ${count} - treating that as the end of the wall.`);
                break;
            }
            seenCount = count;

            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.locator('.show_more_wrap a, ._wall_more_link, .wall_more_link, .ui_show_more')
                .first()
                .click({ timeout: 2_000 })
                .catch(() => {});
            await page.waitForTimeout(2_000);
        }

        const rawPosts = await page.evaluate(extractPostsInPage);
        if (rawPosts.length === 0) {
            throw new Error(`Wall for "${target}" rendered but no posts could be parsed - VK markup may have changed.`);
        }

        const scrapedAt = new Date().toISOString();
        const items = [];
        let missingDates = 0;

        for (const raw of rawPosts) {
            const compositeId = `${raw.ownerId}_${raw.postId}`;
            const postedAt = raw.postedAtUnix ? new Date(raw.postedAtUnix * 1000).toISOString() : null;

            if (!postedAt) missingDates++;
            if (postedAt) {
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

                stats: {
                    likes: raw.likes,
                    comments: raw.comments,
                    reposts: raw.reposts,
                    views: raw.views,
                    engagement: [raw.likes, raw.comments, raw.reposts].some((v) => v !== null)
                        ? (raw.likes ?? 0) + (raw.comments ?? 0) + (raw.reposts ?? 0)
                        : null,
                },

                mediaTypes: raw.mediaTypes,
                mediaCount: raw.mediaTypes.length,
                attachments: raw.thumbnails.map((url) => ({ type: 'thumbnail', url })),

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
                `[${target}] ${missingDates} post(s) had no machine-readable date in the HTML, so "postedAt" is null `
                + 'and date filters could not be applied to them. Use an access token for exact timestamps.',
            );
        }

        await collector.push(items);
    });

    return router;
};
