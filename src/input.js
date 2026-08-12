import { log } from 'apify';

import { describeTarget, parseTarget } from './targets.js';
import { MAX_PAGE_SIZE, parseDateBoundary } from './vk-api.js';

const VALID_POST_FILTERS = new Set(['all', 'owner', 'others']);

/**
 * Validates and normalizes the Actor input, failing loudly and early on
 * anything the crawl cannot recover from.
 *
 * @param {object|null} rawInput Result of `Actor.getInput()`.
 * @returns {{ config: object, targets: Array<ReturnType<typeof parseTarget>> }}
 * @throws {Error} On invalid input.
 */
export const validateInput = (rawInput) => {
    if (!rawInput || typeof rawInput !== 'object') {
        throw new Error('No input provided. At minimum, set "vkTargets" to a list of VK handles, URLs or owner IDs.');
    }

    const {
        vkTargets,
        accessToken,
        maxItems = 500,
        postsPerTarget = null,
        publishedAfter = null,
        publishedBefore = null,
        postFilter = 'all',
        includeComments = false,
        maxComments = 100,
        includeRawPost = false,
        keepUndatedPosts = false,
    } = rawInput;

    if (!Array.isArray(vkTargets) || vkTargets.length === 0) {
        throw new Error('"vkTargets" must be a non-empty array of VK handles, URLs or owner IDs.');
    }

    // Parse every target up front so a typo fails the run before any network cost.
    const targets = [];
    const errors = [];
    for (const raw of vkTargets) {
        try {
            targets.push(parseTarget(raw));
        } catch (error) {
            errors.push(error.message);
        }
    }
    if (targets.length === 0) {
        throw new Error(`None of the supplied targets could be parsed:\n- ${errors.join('\n- ')}`);
    }
    for (const message of errors) log.warning(`Skipping target: ${message}`);

    if (!Number.isInteger(maxItems) || maxItems < 1) {
        throw new Error('"maxItems" must be a positive integer.');
    }
    if (postsPerTarget !== null && (!Number.isInteger(postsPerTarget) || postsPerTarget < 1)) {
        throw new Error('"postsPerTarget" must be a positive integer or left empty.');
    }
    if (!VALID_POST_FILTERS.has(postFilter)) {
        throw new Error(`"postFilter" must be one of: ${[...VALID_POST_FILTERS].join(', ')}.`);
    }
    if (!Number.isInteger(maxComments) || maxComments < 1) {
        throw new Error('"maxComments" must be a positive integer.');
    }

    const after = parseDateBoundary(publishedAfter, 'start', 'publishedAfter');
    const before = parseDateBoundary(publishedBefore, 'end', 'publishedBefore');
    if (after && before && after > before) {
        throw new Error('"publishedAfter" must be earlier than "publishedBefore".');
    }

    const token = typeof accessToken === 'string' && accessToken.trim() ? accessToken.trim() : null;
    const mode = token ? 'api' : 'html';

    if (mode === 'html') {
        log.warning(
            'No "accessToken" supplied - falling back to public HTML scraping. This mode returns fewer fields '
            + '(often no view counts, no attachment URLs, and no exact timestamps) and cannot read closed walls. '
            + 'Provide a VK access token to use the official API.',
        );
        if (includeComments) log.warning('"includeComments" is only supported in API mode and will be ignored.');
    }

    const config = {
        mode,
        accessToken: token,
        maxItems,
        postsPerTarget,
        publishedAfter: after,
        publishedBefore: before,
        postFilter,
        includeComments: mode === 'api' && includeComments === true,
        maxComments,
        includeRawPost: includeRawPost === true,
        keepUndatedPosts: keepUndatedPosts === true,
        pageSize: Math.min(MAX_PAGE_SIZE, postsPerTarget ?? MAX_PAGE_SIZE, maxItems),
    };

    log.info(
        `Resolved ${targets.length} target(s) in "${mode}" mode: ${targets.map(describeTarget).join(', ')}`,
    );

    return { config, targets };
};
