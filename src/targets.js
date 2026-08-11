/**
 * Parses user-supplied VK targets (handles, URLs, numeric owner IDs, post links)
 * into a normalized descriptor the crawler can act on.
 */

/** Screen names VK reserves for its own pages - never a wall we can scrape. */
const RESERVED_SCREEN_NAMES = new Set([
    'dev',
    'about',
    'blog',
    'terms',
    'privacy',
    'help',
    'support',
    'login',
    'feed',
    'im',
    'search',
    'share.php',
    'away.php',
]);

/**
 * Turns `club123` / `public123` / `event123` / `id123` into a signed owner ID.
 * @param {string} screenName
 * @returns {number|null}
 */
const screenNameToOwnerId = (screenName) => {
    const community = /^(?:club|public|event)(\d+)$/i.exec(screenName);
    if (community) return -Number(community[1]);

    const user = /^id(\d+)$/i.exec(screenName);
    if (user) return Number(user[1]);

    return null;
};

/**
 * Strips protocol, host and tracking noise from a VK URL, returning the path
 * plus the parsed query string.
 * @param {string} value
 * @returns {{ path: string, query: URLSearchParams }|null}
 */
const splitVkUrl = (value) => {
    let url;
    try {
        url = new URL(value.includes('://') ? value : `https://${value}`);
    } catch {
        return null;
    }

    const host = url.hostname.replace(/^www\./, '').replace(/^m\./, '');
    if (host !== 'vk.com' && host !== 'vk.ru' && host !== 'vkontakte.ru') return null;

    return {
        path: url.pathname.replace(/^\/+/, '').replace(/\/+$/, ''),
        query: url.searchParams,
    };
};

/**
 * Matches `wall-1_2345` / `wall1_2345` anywhere in a string.
 * @param {string} value
 * @returns {{ ownerId: number, postId: number }|null}
 */
const matchWallPost = (value) => {
    const match = /wall(-?\d+)_(\d+)/i.exec(value);
    if (!match) return null;
    return { ownerId: Number(match[1]), postId: Number(match[2]) };
};

/**
 * Normalizes one raw target string.
 *
 * @param {string} raw Anything the user typed into `vkTargets`.
 * @returns {{ kind: 'wall'|'post', raw: string, targetType: 'handle'|'url'|'ownerId',
 *            domain?: string, ownerId?: number, postId?: number }}
 * @throws {Error} When the value cannot be understood as a VK target.
 */
export const parseTarget = (raw) => {
    const value = String(raw ?? '').trim();
    if (!value) throw new Error('Target is empty.');

    const looksLikeUrl = /^(https?:\/\/)?(www\.|m\.)?vk\.(com|ru)\//i.test(value)
        || /^(https?:\/\/)?(www\.)?vkontakte\.ru\//i.test(value);
    const targetType = looksLikeUrl ? 'url' : (/^-?\d+$/.test(value) ? 'ownerId' : 'handle');

    // 1. A bare signed owner ID, e.g. "-1" (community) or "1" (user).
    if (targetType === 'ownerId') {
        return { kind: 'wall', raw: value, targetType, ownerId: Number(value) };
    }

    // 2. A URL - it may point at a wall, a profile or a single post.
    if (looksLikeUrl) {
        const parts = splitVkUrl(value);
        if (!parts) throw new Error(`Not a VK URL: "${raw}"`);

        // Single post: /wall-1_2345 or /durov?w=wall1_2345
        const post = matchWallPost(parts.path) ?? matchWallPost(parts.query.get('w') ?? '');
        if (post) {
            return { kind: 'post', raw: value, targetType, ...post };
        }

        // Whole wall addressed by owner ID: /wall-1
        const wallOwner = /^wall(-?\d+)$/i.exec(parts.path);
        if (wallOwner) {
            return { kind: 'wall', raw: value, targetType, ownerId: Number(wallOwner[1]) };
        }

        const screenName = parts.path.split('/')[0];
        if (!screenName) throw new Error(`VK URL has no profile or community in it: "${raw}"`);
        if (RESERVED_SCREEN_NAMES.has(screenName.toLowerCase())) {
            throw new Error(`"${screenName}" is a VK service page, not a wall: "${raw}"`);
        }

        const ownerId = screenNameToOwnerId(screenName);
        return ownerId === null
            ? { kind: 'wall', raw: value, targetType, domain: screenName.toLowerCase() }
            : { kind: 'wall', raw: value, targetType, ownerId };
    }

    // 3. A bare handle, possibly still in `wall-1_2345` or `club123` form.
    const post = matchWallPost(value);
    if (post) return { kind: 'post', raw: value, targetType: 'handle', ...post };

    const screenName = value.replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9._]+$/.test(screenName)) {
        throw new Error(`"${raw}" is not a valid VK handle, URL or owner ID.`);
    }
    if (RESERVED_SCREEN_NAMES.has(screenName)) {
        throw new Error(`"${screenName}" is a VK service page, not a wall.`);
    }

    const ownerId = screenNameToOwnerId(screenName);
    return ownerId === null
        ? { kind: 'wall', raw: value, targetType: 'handle', domain: screenName }
        : { kind: 'wall', raw: value, targetType: 'handle', ownerId };
};

/**
 * Human-readable label for logs and for the `target` output field.
 * @param {ReturnType<typeof parseTarget>} target
 * @returns {string}
 */
export const describeTarget = (target) => {
    if (target.kind === 'post') return `wall${target.ownerId}_${target.postId}`;
    return target.domain ?? `wall${target.ownerId}`;
};
