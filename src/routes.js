import { createCheerioRouter, NonRetryableError } from '@crawlee/cheerio';
import { log } from 'apify';

import { buildActorIndex, normalizeComments, normalizePost } from './parse.js';
import {
    MAX_PAGE_SIZE,
    VkApiError,
    buildApiRequest,
    unwrapApiResponse,
} from './vk-api.js';

export const LABELS = {
    WALL: 'WALL',
    POST: 'POST',
};

/**
 * Parses a Crawlee response body into JSON, surfacing block pages as errors
 * rather than letting `JSON.parse` throw something unreadable.
 * @param {Buffer|string} body
 * @param {string} method
 */
const parseJsonBody = (body, method) => {
    const text = body?.toString('utf8') ?? '';
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(
            `VK API ${method} returned a non-JSON body (${text.slice(0, 120).replace(/\s+/g, ' ')}...). `
            + 'This usually means the request was blocked - try a different proxy configuration.',
        );
    }
};

/**
 * Fetches every comment page for a post, up to `maxComments`.
 *
 * @param {object} options
 * @param {Function} options.sendRequest Crawlee's proxied HTTP helper.
 * @param {number} options.ownerId
 * @param {number} options.postId
 * @param {number} options.maxComments
 * @param {string} options.accessToken
 * @returns {Promise<{items: object[], total: number|null}>}
 */
const fetchComments = async ({ sendRequest, ownerId, postId, maxComments, accessToken }) => {
    const collected = [];
    let total = null;
    let offset = 0;

    while (collected.length < maxComments) {
        const count = Math.min(MAX_PAGE_SIZE, maxComments - collected.length);
        const request = buildApiRequest(
            'wall.getComments',
            {
                owner_id: ownerId,
                post_id: postId,
                offset,
                count,
                extended: 1,
                thread_items_count: 10,
                sort: 'asc',
            },
            accessToken,
            {},
            `comments:${ownerId}_${postId}:${offset}`,
        );

        const response = await sendRequest({
            url: request.url,
            method: 'POST',
            body: request.payload,
            headers: request.headers,
            responseType: 'text',
        });

        const payload = unwrapApiResponse(parseJsonBody(response.body, 'wall.getComments'), 'wall.getComments');
        const index = buildActorIndex(payload);
        const page = normalizeComments(payload.items, index);

        // Thread replies come nested; flatten them so no comment text is lost.
        for (const [i, raw] of (payload.items ?? []).entries()) {
            if (raw.thread?.items?.length) {
                page[i].replies = normalizeComments(raw.thread.items, index);
            }
        }

        collected.push(...page);
        total = payload.count ?? total;

        if (page.length === 0 || collected.length >= (payload.count ?? 0)) break;
        offset += count;
    }

    return { items: collected.slice(0, maxComments), total };
};

/**
 * Builds the router for the VK API crawl.
 *
 * @param {object} context
 * @param {import('./results.js').ResultCollector} context.collector
 * @param {object} context.config Validated input.
 * @param {{ fatalError: Error|null }} context.runState Shared abort signal.
 * @returns {import('@crawlee/cheerio').CheerioRouter}
 */
export const createApiRouter = ({ collector, config, runState }) => {
    const router = createCheerioRouter();

    /**
     * Turns raw VK items into dataset items, applying the date window.
     * @returns {{ items: object[], hitOlderThanWindow: boolean }}
     */
    const normalizeBatch = (rawItems, index, request) => {
        const { target, targetType } = request.userData;
        const items = [];
        let hitOlderThanWindow = false;

        for (const raw of rawItems) {
            const post = normalizePost(raw, {
                index,
                target,
                targetType,
                includeRawPost: config.includeRawPost,
            });

            const postedAt = post.postedAt ? new Date(post.postedAt) : null;
            if (postedAt && config.publishedAfter && postedAt < config.publishedAfter) {
                // A pinned post is served out of order, so it must not end pagination.
                if (!post.isPinned) hitOlderThanWindow = true;
                continue;
            }
            if (postedAt && config.publishedBefore && postedAt > config.publishedBefore) continue;

            items.push(post);
        }

        return { items, hitOlderThanWindow };
    };

    /** Attaches comment threads to already-normalized posts. */
    const attachComments = async (items, sendRequest) => {
        if (!config.includeComments) return;

        for (const item of items) {
            if (item.stats.comments === 0 || item.postId === null) {
                item.comments = [];
                continue;
            }
            const [ownerId, postId] = item.postId.split('_').map(Number);
            try {
                const { items: comments } = await fetchComments({
                    sendRequest,
                    ownerId,
                    postId,
                    maxComments: config.maxComments,
                    accessToken: config.accessToken,
                });
                item.comments = comments;
            } catch (error) {
                // A post whose comments are closed must not sink the whole post.
                log.softFail(`Could not fetch comments for wall${item.postId}: ${error.message}`);
                item.comments = [];
            }
        }
    };

    router.addHandler(LABELS.WALL, async ({ request, body, crawler, sendRequest }) => {
        const { target, targetType, offset, perTargetPushed, ownerId, domain } = request.userData;
        const response = unwrapApiResponse(parseJsonBody(body, 'wall.get'), 'wall.get');

        const rawItems = response.items ?? [];
        const totalOnWall = response.count ?? null;
        log.info(`[${target}] wall.get offset=${offset} returned ${rawItems.length} post(s) of ${totalOnWall ?? '?'}.`);

        const index = buildActorIndex(response);
        const { items, hitOlderThanWindow } = normalizeBatch(rawItems, index, request);

        // Trim to whichever budget bites first before doing expensive comment fetches.
        const perTargetRemaining = config.postsPerTarget === null
            ? Number.POSITIVE_INFINITY
            : Math.max(0, config.postsPerTarget - perTargetPushed);
        const allowed = items.slice(0, Math.min(perTargetRemaining, collector.remaining));

        await attachComments(allowed, sendRequest);
        const storedCount = await collector.push(allowed);
        const totalPushedForTarget = perTargetPushed + storedCount;

        const nextOffset = offset + rawItems.length;
        const exhaustedWall = rawItems.length === 0
            || (totalOnWall !== null && nextOffset >= totalOnWall);
        const reachedPerTargetLimit = config.postsPerTarget !== null
            && totalPushedForTarget >= config.postsPerTarget;

        if (collector.isFull) {
            log.info(`Global maxItems (${config.maxItems}) reached - stopping.`);
            return;
        }
        if (reachedPerTargetLimit) {
            log.info(`[${target}] postsPerTarget (${config.postsPerTarget}) reached.`);
            return;
        }
        if (exhaustedWall) {
            log.info(`[${target}] Reached the end of the wall.`);
            return;
        }
        if (hitOlderThanWindow) {
            log.info(`[${target}] Posts are now older than "publishedAfter" - stopping pagination.`);
            return;
        }

        const pageSize = Math.min(MAX_PAGE_SIZE, collector.remaining, perTargetRemaining || MAX_PAGE_SIZE);
        await crawler.addRequests([
            buildApiRequest(
                'wall.get',
                {
                    ...(domain ? { domain } : { owner_id: ownerId }),
                    offset: nextOffset,
                    count: Math.max(1, pageSize),
                    extended: 1,
                    filter: config.postFilter,
                    fields: 'screen_name,photo_200,verified,members_count',
                },
                config.accessToken,
                { label: LABELS.WALL, target, targetType, offset: nextOffset, perTargetPushed: totalPushedForTarget, ownerId, domain },
                `wall:${domain ?? ownerId}:${nextOffset}`,
            ),
        ]);
    });

    router.addHandler(LABELS.POST, async ({ request, body, sendRequest }) => {
        const { target } = request.userData;
        const response = unwrapApiResponse(parseJsonBody(body, 'wall.getById'), 'wall.getById');

        // `extended=1` returns {items, profiles, groups}; older versions return a bare array.
        const rawItems = Array.isArray(response) ? response : (response.items ?? []);
        if (rawItems.length === 0) {
            log.softFail(`[${target}] Post not found, deleted, or not publicly readable.`);
            return;
        }

        const index = buildActorIndex(Array.isArray(response) ? {} : response);
        const { items } = normalizeBatch(rawItems, index, request);
        await attachComments(items, sendRequest);
        await collector.push(items);
    });

    router.addDefaultHandler(async ({ request }) => {
        throw new NonRetryableError(`Request without a routing label reached the crawler: ${request.url}`);
    });

    // Distinguish "skip this target" from "retry" from "the token is dead".
    router.use(async (ctx) => {
        ctx.request.userData.__attempt = (ctx.request.userData.__attempt ?? 0) + 1;
    });

    /**
     * Classifies a handler error. Exposed on the router so `failedRequestHandler`
     * and the error hook share one policy.
     * @param {Error} error
     */
    router.classifyError = (error) => {
        if (!(error instanceof VkApiError)) return { retry: true };
        if (error.isFatal) {
            runState.fatalError = error;
            return { retry: false, fatal: true };
        }
        return { retry: error.isRetryable };
    };

    return router;
};
