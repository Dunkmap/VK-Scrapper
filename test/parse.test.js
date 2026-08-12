import { describe, expect, it } from 'vitest';

import { buildActorIndex, normalizeAttachment, normalizeComments, normalizePost, toIso } from '../src/parse.js';

const index = buildActorIndex({
    profiles: [{ id: 1, first_name: 'Pavel', last_name: 'Durov', screen_name: 'durov', photo_200: 'p.jpg', verified: 1 }],
    groups: [{ id: 22822305, name: 'Kinopoisk', screen_name: 'kinopoisk', members_count: 100, verified: 1 }],
});

const baseOptions = { index, target: 'kinopoisk', targetType: 'handle' };

describe('toIso', () => {
    it('converts unix seconds to ISO', () => {
        expect(toIso(1_700_000_000)).toBe('2023-11-14T22:13:20.000Z');
    });

    it.each([null, undefined, 0, -1, Number.NaN, 'x'])('returns null for %s', (value) => {
        expect(toIso(value)).toBeNull();
    });
});

describe('buildActorIndex', () => {
    it('keys communities by their negative ID', () => {
        expect(index.get(-22822305)).toMatchObject({ type: 'group', name: 'Kinopoisk', url: 'https://vk.com/kinopoisk' });
    });

    it('joins user names', () => {
        expect(index.get(1)).toMatchObject({ type: 'user', name: 'Pavel Durov', isVerified: true });
    });
});

describe('normalizeAttachment', () => {
    it('picks the largest photo size and keeps the rest', () => {
        const attachment = normalizeAttachment({
            type: 'photo',
            photo: {
                id: 7, owner_id: -1, text: 'caption', date: 1_700_000_000,
                sizes: [
                    { type: 'm', url: 'small.jpg', width: 130, height: 100 },
                    { type: 'w', url: 'big.jpg', width: 2560, height: 1920 },
                ],
            },
        }, index);

        expect(attachment).toMatchObject({
            type: 'photo', id: '-1_7', url: 'big.jpg', width: 2560, height: 1920, text: 'caption',
        });
        expect(attachment.sizes).toHaveLength(2);
    });

    it('builds a canonical video URL', () => {
        expect(normalizeAttachment({
            type: 'video',
            video: { id: 9, owner_id: -1, title: 'Trailer', duration: 120, views: 5 },
        }, index)).toMatchObject({ url: 'https://vk.com/video-1_9', title: 'Trailer', durationSeconds: 120, viewsCount: 5 });
    });

    it('keeps poll answers', () => {
        const poll = normalizeAttachment({
            type: 'poll',
            poll: { id: 1, owner_id: -1, question: 'Q?', votes: 10, answers: [{ id: 1, text: 'A', votes: 6, rate: 60 }] },
        }, index);
        expect(poll.answers).toEqual([{ id: 1, text: 'A', votes: 6, rate: 60 }]);
    });

    it('resolves the author of a wall_reply', () => {
        expect(normalizeAttachment({
            type: 'wall_reply',
            wall_reply: { id: 3, owner_id: -1, from_id: 1, text: 'hi', date: 1_700_000_000 },
        }, index).author).toMatchObject({ name: 'Pavel Durov' });
    });

    it('degrades gracefully on an unknown type', () => {
        expect(normalizeAttachment({ type: 'newthing', newthing: { id: 1, owner_id: -1 } }, index))
            .toMatchObject({ type: 'newthing', isKnownType: false, id: '-1_1' });
    });

    it('returns null when there is no type', () => {
        expect(normalizeAttachment({}, index)).toBeNull();
    });
});

describe('normalizePost', () => {
    const rawPost = {
        id: 42,
        owner_id: -22822305,
        from_id: -22822305,
        date: 1_700_000_000,
        edited: 1_700_000_500,
        text: 'Hello',
        post_type: 'post',
        is_pinned: 1,
        marked_as_ads: 0,
        signer_id: 1,
        likes: { count: 10 },
        comments: { count: 4, can_post: 1 },
        reposts: { count: 2 },
        views: { count: 900 },
        post_source: { type: 'api', platform: 'android' },
        geo: { type: 'point', coordinates: '55.7 37.6', place: { title: 'Moscow', country: 'Russia', city: 'Moscow' } },
        attachments: [{ type: 'photo', photo: { id: 1, owner_id: -1, sizes: [{ type: 'x', url: 'a.jpg', width: 600, height: 400 }] } }],
        copy_history: [{ id: 9, owner_id: 1, from_id: 1, date: 1_699_000_000, text: 'Original', likes: { count: 3 } }],
    };

    it('maps the headline fields', () => {
        const post = normalizePost(rawPost, baseOptions);
        expect(post).toMatchObject({
            postId: '-22822305_42',
            ownerId: -22822305,
            authorId: -22822305,
            text: 'Hello',
            postedAt: '2023-11-14T22:13:20.000Z',
            editedAt: '2023-11-14T22:21:40.000Z',
            sourceUrl: 'https://vk.com/wall-22822305_42',
            isPinned: true,
            isAd: false,
            canComment: true,
            target: 'kinopoisk',
            targetType: 'handle',
        });
        expect(post.author).toMatchObject({ name: 'Kinopoisk' });
        expect(post.signer).toMatchObject({ name: 'Pavel Durov' });
        expect(post.geo).toMatchObject({ title: 'Moscow', country: 'Russia' });
        expect(post.postSource).toEqual({ type: 'api', platform: 'android' });
    });

    it('sums only the engagement signals VK returned', () => {
        expect(normalizePost(rawPost, baseOptions).stats).toEqual({
            likes: 10, comments: 4, reposts: 2, views: 900, engagement: 16,
        });
    });

    it('keeps missing counters null instead of zero', () => {
        const post = normalizePost({ id: 1, owner_id: -1, date: 1_700_000_000, text: '' }, baseOptions);
        expect(post.stats).toEqual({ likes: null, comments: null, reposts: null, views: null, engagement: null });
    });

    it('extracts attachment URLs and media types', () => {
        const post = normalizePost(rawPost, baseOptions);
        expect(post.mediaTypes).toEqual(['photo']);
        expect(post.mediaCount).toBe(1);
        expect(post.attachments[0].url).toBe('a.jpg');
    });

    it('normalizes the repost chain', () => {
        const post = normalizePost(rawPost, baseOptions);
        expect(post.isRepost).toBe(true);
        expect(post.repostChain).toHaveLength(1);
        expect(post.repostChain[0]).toMatchObject({ postId: '1_9', text: 'Original' });
        expect(post.repostChain[0].author).toMatchObject({ name: 'Pavel Durov' });
    });

    it('caps repost recursion instead of hanging on a cycle', () => {
        const deep = (depth) => (depth === 0
            ? { id: 1, owner_id: 1, date: 1, text: 'end' }
            : { id: depth, owner_id: 1, date: 1, text: `l${depth}`, copy_history: [deep(depth - 1)] });

        let node = normalizePost(deep(12), baseOptions);
        let levels = 0;
        while (node.repostChain.length > 0) {
            node = node.repostChain[0];
            levels++;
        }
        expect(levels).toBeLessThanOrEqual(5);
    });

    it('omits rawPost unless asked for it', () => {
        expect(normalizePost(rawPost, baseOptions).rawPost).toBeUndefined();
        expect(normalizePost(rawPost, { ...baseOptions, includeRawPost: true }).rawPost).toBe(rawPost);
    });

    it('never invents values for an empty post', () => {
        const post = normalizePost({}, baseOptions);
        expect(post.postId).toBeNull();
        expect(post.postedAt).toBeNull();
        expect(post.sourceUrl).toBeNull();
        expect(post.text).toBe('');
        expect(post.attachments).toEqual([]);
    });
});

describe('normalizeComments', () => {
    it('maps author, text and reply pointers', () => {
        expect(normalizeComments([{
            id: 5, owner_id: -1, from_id: 1, date: 1_700_000_000, text: 'nice',
            likes: { count: 2 }, reply_to_comment: 4, reply_to_user: 1, thread: { count: 3 },
        }], index)[0]).toMatchObject({
            commentId: '-1_5',
            text: 'nice',
            likes: 2,
            replyToCommentId: 4,
            threadCount: 3,
        });
    });

    it('returns an empty array for no comments', () => {
        expect(normalizeComments(undefined, index)).toEqual([]);
    });
});
