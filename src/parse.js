/**
 * Normalizes raw VK API objects into the flat, documented dataset shape.
 *
 * Every function here is pure: given a VK payload it returns plain data, and it
 * returns `null`/empty values when a field is genuinely absent. Nothing in this
 * module invents values - a missing field must stay missing so consumers can
 * tell "no data" apart from "zero".
 */

/** Attachment types VK can return; anything unknown falls through to a generic shape. */
const KNOWN_ATTACHMENT_TYPES = new Set([
    'photo', 'video', 'audio', 'doc', 'link', 'poll', 'album', 'market',
    'market_album', 'sticker', 'gift', 'note', 'page', 'podcast', 'graffiti',
    'audio_message', 'wall', 'wall_reply', 'event', 'story', 'article', 'call',
    'pretty_cards', 'textlive',
]);

/**
 * @param {number|null|undefined} unixSeconds
 * @returns {string|null} ISO-8601 timestamp, or null when VK sent no date.
 */
export const toIso = (unixSeconds) => {
    if (typeof unixSeconds !== 'number' || !Number.isFinite(unixSeconds) || unixSeconds <= 0) return null;
    const date = new Date(unixSeconds * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/**
 * Picks the highest-resolution entry from a VK `sizes` array.
 * @param {Array<{url?: string, src?: string, width?: number, height?: number}>} sizes
 */
const largestSize = (sizes) => {
    if (!Array.isArray(sizes) || sizes.length === 0) return null;
    return sizes.reduce((best, size) => {
        const area = (size.width ?? 0) * (size.height ?? 0);
        const bestArea = (best.width ?? 0) * (best.height ?? 0);
        return area > bestArea ? size : best;
    }, sizes[0]);
};

/**
 * Builds an index of the `profiles` and `groups` arrays returned by
 * `extended=1` calls, so author IDs can be resolved to names.
 *
 * @param {{profiles?: object[], groups?: object[]}} response
 * @returns {Map<number, object>} Keyed by signed VK ID (negative for communities).
 */
export const buildActorIndex = (response) => {
    const index = new Map();

    for (const profile of response?.profiles ?? []) {
        index.set(profile.id, {
            id: profile.id,
            type: 'user',
            name: [profile.first_name, profile.last_name].filter(Boolean).join(' ') || null,
            screenName: profile.screen_name ?? (profile.id ? `id${profile.id}` : null),
            url: profile.screen_name ? `https://vk.com/${profile.screen_name}` : `https://vk.com/id${profile.id}`,
            photo: profile.photo_200 ?? profile.photo_100 ?? profile.photo_50 ?? null,
            isVerified: profile.verified === 1,
            isClosed: profile.is_closed ?? null,
        });
    }

    for (const group of response?.groups ?? []) {
        index.set(-group.id, {
            id: -group.id,
            type: group.type === 'event' ? 'event' : (group.type === 'page' ? 'page' : 'group'),
            name: group.name ?? null,
            screenName: group.screen_name ?? `club${group.id}`,
            url: `https://vk.com/${group.screen_name ?? `club${group.id}`}`,
            photo: group.photo_200 ?? group.photo_100 ?? group.photo_50 ?? null,
            isVerified: group.verified === 1,
            membersCount: group.members_count ?? null,
        });
    }

    return index;
};

/**
 * @param {number|undefined} id Signed VK ID.
 * @param {Map<number, object>} index
 */
const resolveActor = (id, index) => {
    if (typeof id !== 'number') return null;
    return index.get(id) ?? {
        id,
        type: id < 0 ? 'group' : 'user',
        name: null,
        screenName: id < 0 ? `club${-id}` : `id${id}`,
        url: `https://vk.com/${id < 0 ? `club${-id}` : `id${id}`}`,
        photo: null,
    };
};

/**
 * Converts one VK attachment into a flat object with a direct URL where VK
 * exposes one.
 *
 * @param {object} attachment
 * @param {Map<number, object>} index
 * @returns {object|null}
 */
export const normalizeAttachment = (attachment, index) => {
    const type = attachment?.type;
    if (!type) return null;

    const payload = attachment[type];
    const base = { type, isKnownType: KNOWN_ATTACHMENT_TYPES.has(type) };
    if (!payload || typeof payload !== 'object') return base;

    if (payload.owner_id !== undefined && payload.id !== undefined) {
        base.id = `${payload.owner_id}_${payload.id}`;
        base.ownerId = payload.owner_id;
    }
    if (payload.access_key) base.accessKey = payload.access_key;

    switch (type) {
        case 'photo': {
            const size = largestSize(payload.sizes);
            return {
                ...base,
                url: size?.url ?? size?.src ?? null,
                width: size?.width ?? null,
                height: size?.height ?? null,
                text: payload.text || null,
                postedAt: toIso(payload.date),
                sizes: (payload.sizes ?? []).map((s) => ({
                    type: s.type, url: s.url ?? s.src ?? null, width: s.width ?? null, height: s.height ?? null,
                })),
            };
        }

        case 'video':
            return {
                ...base,
                url: base.id
                    ? `https://vk.com/video${base.id}${payload.access_key ? `?list=${payload.access_key}` : ''}`
                    : null,
                playerUrl: payload.player ?? null,
                title: payload.title ?? null,
                description: payload.description || null,
                durationSeconds: payload.duration ?? null,
                viewsCount: payload.views ?? null,
                thumbnail: largestSize(payload.image)?.url ?? payload.photo_800 ?? payload.photo_320 ?? null,
                isLive: payload.live === 1,
                postedAt: toIso(payload.date),
            };

        case 'audio':
            return {
                ...base,
                url: payload.url || null,
                artist: payload.artist ?? null,
                title: payload.title ?? null,
                durationSeconds: payload.duration ?? null,
                genreId: payload.genre_id ?? null,
            };

        case 'audio_message':
            return {
                ...base,
                url: payload.link_mp3 ?? payload.link_ogg ?? null,
                durationSeconds: payload.duration ?? null,
                transcript: payload.transcript || null,
            };

        case 'doc':
            return {
                ...base,
                url: payload.url || null,
                title: payload.title ?? null,
                extension: payload.ext ?? null,
                sizeBytes: payload.size ?? null,
                thumbnail: largestSize(payload.preview?.photo?.sizes)?.src ?? null,
            };

        case 'link':
            return {
                ...base,
                url: payload.url || null,
                title: payload.title ?? null,
                caption: payload.caption ?? null,
                description: payload.description || null,
                thumbnail: largestSize(payload.photo?.sizes)?.url ?? null,
            };

        case 'poll':
            return {
                ...base,
                question: payload.question ?? null,
                votesCount: payload.votes ?? null,
                isAnonymous: payload.anonymous ?? null,
                isMultiple: payload.multiple ?? null,
                endsAt: toIso(payload.end_date),
                createdAt: toIso(payload.created),
                answers: (payload.answers ?? []).map((a) => ({
                    id: a.id, text: a.text, votes: a.votes ?? null, rate: a.rate ?? null,
                })),
            };

        case 'album':
            return {
                ...base,
                title: payload.title ?? null,
                description: payload.description || null,
                size: payload.size ?? null,
                thumbnail: largestSize(payload.thumb?.sizes)?.url ?? null,
            };

        case 'market':
            return {
                ...base,
                title: payload.title ?? null,
                description: payload.description || null,
                price: payload.price?.text ?? null,
                currency: payload.price?.currency?.name ?? null,
                category: payload.category?.name ?? null,
                thumbnail: largestSize(payload.thumb_photo ? [] : payload.photos?.[0]?.sizes)?.url
                    ?? payload.thumb_photo ?? null,
                availability: payload.availability ?? null,
            };

        case 'sticker':
            return {
                ...base,
                stickerId: payload.sticker_id ?? null,
                productId: payload.product_id ?? null,
                url: largestSize(payload.images_with_background ?? payload.images)?.url ?? null,
            };

        case 'gift':
            return { ...base, thumbnail: payload.thumb_256 ?? payload.thumb_96 ?? null };

        case 'graffiti':
            return { ...base, url: payload.url ?? null, width: payload.width ?? null, height: payload.height ?? null };

        case 'note':
            return { ...base, title: payload.title ?? null, text: payload.text || null, url: payload.view_url ?? null };

        case 'page':
            return { ...base, title: payload.title ?? null, url: payload.view_url ?? null };

        case 'podcast':
            return {
                ...base,
                title: payload.title ?? null,
                url: payload.url || null,
                durationSeconds: payload.duration ?? null,
                description: payload.podcast_info?.description || null,
            };

        case 'article':
            return {
                ...base,
                url: payload.url ?? null,
                title: payload.title ?? null,
                subtitle: payload.subtitle ?? null,
                viewsCount: payload.views ?? null,
                thumbnail: largestSize(payload.photo?.sizes)?.url ?? null,
            };

        case 'story':
            return { ...base, url: base.id ? `https://vk.com/story${base.id}` : null, expiresAt: toIso(payload.expires_at) };

        case 'event':
            return { ...base, id: payload.id ? String(payload.id) : null, text: payload.text ?? null, buttonText: payload.button_text ?? null };

        case 'wall_reply':
            return {
                ...base,
                text: payload.text || null,
                author: resolveActor(payload.from_id, index),
                postedAt: toIso(payload.date),
            };

        // A reposted post attached to this one - normalized by the caller to avoid recursion here.
        case 'wall':
            return { ...base, text: payload.text || null, postedAt: toIso(payload.date) };

        default:
            return base;
    }
};

/**
 * Normalizes a full VK wall post, including its repost chain.
 *
 * @param {object} post Raw `wall.get` item.
 * @param {object} options
 * @param {Map<number, object>} options.index Actor index from `buildActorIndex`.
 * @param {string} options.target Original target string the user supplied.
 * @param {'handle'|'url'|'ownerId'} options.targetType
 * @param {boolean} [options.includeRawPost]
 * @param {number} [options.depth] Recursion guard for `copy_history`.
 * @returns {object} Dataset item.
 */
export const normalizePost = (post, { index, target, targetType, includeRawPost = false, depth = 0 }) => {
    const ownerId = post.owner_id ?? post.to_id ?? null;
    const postId = post.id ?? null;
    const compositeId = ownerId !== null && postId !== null ? `${ownerId}_${postId}` : null;

    const attachments = (post.attachments ?? [])
        .map((attachment) => normalizeAttachment(attachment, index))
        .filter(Boolean);

    // VK nests reposts in `copy_history`, oldest last. Depth is capped defensively;
    // real chains are short but the field is attacker-controlled data.
    const repostChain = depth < 5
        ? (post.copy_history ?? []).map((original) => normalizePost(original, {
            index, target, targetType, includeRawPost, depth: depth + 1,
        }))
        : [];

    const likes = post.likes?.count ?? null;
    const comments = post.comments?.count ?? null;
    const reposts = post.reposts?.count ?? null;
    const views = post.views?.count ?? null;

    const item = {
        postId: compositeId,
        ownerId,
        authorId: post.from_id ?? ownerId,
        author: resolveActor(post.from_id ?? ownerId, index),
        wallOwner: resolveActor(ownerId, index),

        text: post.text ?? '',
        postedAt: toIso(post.date),
        editedAt: toIso(post.edited),
        sourceUrl: compositeId ? `https://vk.com/wall${compositeId}` : null,

        stats: {
            likes,
            comments,
            reposts,
            views,
            // Only sum the signals VK actually returned; null stays null.
            engagement: [likes, comments, reposts].some((v) => v !== null)
                ? (likes ?? 0) + (comments ?? 0) + (reposts ?? 0)
                : null,
        },

        mediaTypes: attachments.map((a) => a.type),
        mediaCount: attachments.length,
        attachments,

        isRepost: repostChain.length > 0,
        repostChain,

        postType: post.post_type ?? null,
        isPinned: post.is_pinned === 1,
        isAd: post.marked_as_ads === 1,
        isFavorite: post.is_favorite === true,
        canComment: post.comments?.can_post === 1 ? true : (post.comments?.can_post === 0 ? false : null),
        signerId: post.signer_id ?? null,
        signer: post.signer_id ? resolveActor(post.signer_id, index) : null,
        createdBy: post.created_by ?? null,
        postSource: post.post_source
            ? { type: post.post_source.type ?? null, platform: post.post_source.platform ?? null }
            : null,
        geo: post.geo
            ? {
                type: post.geo.type ?? null,
                coordinates: post.geo.coordinates ?? null,
                title: post.geo.place?.title ?? null,
                country: post.geo.place?.country ?? null,
                city: post.geo.place?.city ?? null,
            }
            : null,
        donutIsPaid: post.donut?.is_donut === true,

        target,
        targetType,
        scrapedAt: new Date().toISOString(),
    };

    if (includeRawPost) item.rawPost = post;
    return item;
};

/**
 * Normalizes comments fetched via `wall.getComments`.
 *
 * @param {object[]} rawComments
 * @param {Map<number, object>} index
 * @returns {object[]}
 */
export const normalizeComments = (rawComments, index) => (rawComments ?? []).map((comment) => ({
    commentId: comment.owner_id !== undefined && comment.id !== undefined
        ? `${comment.owner_id}_${comment.id}`
        : null,
    author: resolveActor(comment.from_id, index),
    text: comment.text ?? '',
    postedAt: toIso(comment.date),
    likes: comment.likes?.count ?? null,
    replyToCommentId: comment.reply_to_comment ?? null,
    replyToUserId: comment.reply_to_user ?? null,
    threadCount: comment.thread?.count ?? null,
    attachments: (comment.attachments ?? []).map((a) => normalizeAttachment(a, index)).filter(Boolean),
}));
