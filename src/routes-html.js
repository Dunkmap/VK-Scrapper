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

/**
 * Runs in the browser: reads every wall post currently in the DOM.
 * Kept dependency-free because it is serialized into the page context.
 */
const extractPostsInPage = () => {
    /** @param {Element} root @param {string[]} selectors */
    const firstText = (root, selectors) => {
        for (const selector of selectors) {
            const node = root.querySelector(selector);
            const text = node?.textContent?.trim();
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

        // VK sometimes stamps an absolute unix time on the date element.
        const dateNode = container.querySelector('[time], time, .pi_date, .rel_date, .PostHeaderSubtitle__item');
        const unix = Number(
            dateNode?.getAttribute?.('time')
            ?? dateNode?.getAttribute?.('data-time')
            ?? dateNode?.getAttribute?.('datetime')
            ?? NaN,
        );

        const thumbnails = [...container.querySelectorAll('img')]
            .map((img) => img.getAttribute('src') || img.getAttribute('data-src'))
            .filter((src) => src && !src.startsWith('data:'));

        const mediaTypes = [];
        if (container.querySelector('a[href*="/photo"], .PhotoPrimaryAttachment, .page_post_sized_thumbs')) mediaTypes.push('photo');
        if (container.querySelector('a[href*="/video"], .post_video_desc, .VideoSnippet')) mediaTypes.push('video');
        if (container.querySelector('a[href*="/audio"], .audio_row')) mediaTypes.push('audio');
        if (container.querySelector('a[href*="/doc"], .page_doc_row')) mediaTypes.push('doc');
        if (container.querySelector('.PollQuestion, .poll_board')) mediaTypes.push('poll');

        results.push({
            ownerId,
            postId,
            text: firstText(container, ['.pi_text', '.wall_post_text', '.PostText', '.post_info .wall_post_text']) ?? '',
            postedAtUnix: Number.isFinite(unix) && unix > 0 ? unix : null,
            postedAtText: dateNode?.textContent?.trim() ?? null,
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

        await page.waitForSelector('[data-post-id], .wall_item, ._post', { timeout: 20_000 })
            .catch(() => {
                throw new Error(
                    `No wall posts rendered for "${target}". The wall is private, empty, or VK served a login wall. `
                    + 'Supply an "accessToken" to use the official API instead.',
                );
            });

        // Scroll until VK stops adding posts or we have enough.
        let seenCount = 0;
        for (let round = 0; round < MAX_SCROLL_ROUNDS; round++) {
            const count = await page.evaluate(
                () => document.querySelectorAll('[data-post-id], .wall_item, ._post').length,
            );
            if (count >= wanted) break;

            if (count === seenCount && round > 0) break;
            seenCount = count;

            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.locator('.show_more_wrap a, ._wall_more_link, .wall_more_link')
                .first()
                .click({ timeout: 2_000 })
                .catch(() => {});
            await page.waitForTimeout(1_500);
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
