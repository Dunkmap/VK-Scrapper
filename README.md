# VK Posts Scraper

Extracts wall posts from public VK profiles and communities, with every field VK exposes for a post: text, author, engagement stats, attachment URLs, repost chains, geotags, poll results and — optionally — full comment threads.

## Input

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `vkTargets` | string[] | **required** | Handles (`durov`), profile/community URLs (`https://vk.com/kinopoisk`), signed owner IDs (`-40316705`), or direct post links (`https://vk.com/wall1_45678`). |
| `accessToken` | string (secret) | — | VK API token with the `wall` scope. Strongly recommended — see [Extraction modes](#extraction-modes). |
| `maxItems` | integer | `500` | Hard cap on posts stored across all targets. |
| `postsPerTarget` | integer | — | Optional per-target cap. |
| `publishedAfter` | string | — | `YYYY-MM-DD` or ISO-8601. Pagination stops once older posts are reached. |
| `publishedBefore` | string | — | `YYYY-MM-DD` or ISO-8601. A bare date includes the whole day. |
| `postFilter` | `all` \| `owner` \| `others` | `all` | Which posts to read from the wall (API mode only). |
| `includeComments` | boolean | `false` | Fetch comment threads, including replies. API mode only. |
| `maxComments` | integer | `100` | Comments fetched per post. |
| `includeRawPost` | boolean | `false` | Attach the unmodified VK payload as `rawPost`. |
| `proxyConfiguration` | object | Residential | VK blocks most datacenter IP ranges. |

```json
{
    "vkTargets": ["kinopoisk", "https://vk.com/durov"],
    "accessToken": "vk1.a.…",
    "maxItems": 200,
    "publishedAfter": "2024-01-01",
    "includeComments": true
}
```

## Extraction modes

**API mode** (an `accessToken` is supplied) calls the official VK API — `wall.get`, `wall.getById`, `wall.getComments`. This is the mode the Actor is built around and the only one that returns complete data. Get a token by creating a [standalone VK application](https://dev.vk.com/) and issuing a user token with the `wall` scope.

**HTML mode** (no token) scrapes `m.vk.com` in a browser. It is a genuine fallback, not a substitute: VK's public HTML has no attachment URLs beyond thumbnails, often no view counts, and dates that frequently cannot be resolved to an exact timestamp (those posts get `postedAt: null` and a raw `postedAtLabel` instead). Closed walls and single-post targets are not reachable at all.

Neither mode ever fabricates a value. A field VK does not return is `null`, and a failed extraction fails the run rather than producing placeholder data.

## Output

One dataset item per post:

```json
{
    "postId": "-22822305_1070789",
    "ownerId": -22822305,
    "authorId": -22822305,
    "author": {
        "id": -22822305,
        "type": "group",
        "name": "Кинопоиск",
        "screenName": "kinopoisk",
        "url": "https://vk.com/kinopoisk",
        "photo": "https://sun.userapi.com/…",
        "isVerified": true,
        "membersCount": 2100000
    },
    "text": "Post body…",
    "postedAt": "2024-06-01T09:30:00.000Z",
    "editedAt": null,
    "sourceUrl": "https://vk.com/wall-22822305_1070789",
    "stats": { "likes": 1240, "comments": 87, "reposts": 33, "views": 98000, "engagement": 1360 },
    "mediaTypes": ["photo", "video"],
    "mediaCount": 2,
    "attachments": [
        { "type": "photo", "id": "-22822305_457301", "url": "https://sun.userapi.com/…jpg", "width": 2560, "height": 1440, "sizes": [] },
        { "type": "video", "id": "-22822305_456789", "url": "https://vk.com/video-22822305_456789", "title": "Trailer", "durationSeconds": 132, "viewsCount": 45000 }
    ],
    "isRepost": false,
    "repostChain": [],
    "isPinned": false,
    "isAd": false,
    "geo": null,
    "postSource": { "type": "vk", "platform": null },
    "target": "kinopoisk",
    "targetType": "handle",
    "scrapedAt": "2024-06-02T11:00:00.000Z"
}
```

Attachment objects carry type-specific fields — `poll` has `question`/`answers`/`votesCount`, `link` has `url`/`title`/`description`, `doc` has `extension`/`sizeBytes`, and so on. Unmapped attachment types still appear with their `type`, `id` and `isKnownType: false`, so nothing is silently dropped. With `includeComments`, each post also gets a `comments` array whose entries carry the commenter, text, likes and nested `replies`.

## Limits and behaviour

- **Rate limits.** VK allows roughly 3 requests/second per user token; the Actor runs API requests one at a time and retries error code 6 with backoff.
- **Budgets.** `maxItems` counts posts, not requests, and is enforced globally across targets. Posts are de-duplicated by `ownerId_postId`.
- **Failure.** A run that stores zero posts fails with a diagnostic message instead of finishing "successfully" with an empty dataset. An invalid or expired token fails the run immediately.
- **Scope.** Only public walls, or walls the supplied token can read. This Actor does not attempt to access private profiles or bypass VK's access controls.

## Development

```bash
npm install
npm test     # unit + handler tests, no network access
npm run lint
apify run    # requires an INPUT in storage/key_value_stores/default/
```
