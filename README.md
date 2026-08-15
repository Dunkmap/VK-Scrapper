## What does VK Posts Scraper do?

**VK Posts Scraper extracts wall posts from public [VK (VKontakte)](https://vk.com) profiles and communities** — post text, publication timestamps, attachment URLs with their VK object IDs, repost chains, and engagement counts. Give it a handle like `durov`, a community URL, an owner ID, or a direct post link, and it walks the wall and returns structured JSON.

It runs on the Apify platform, so you get scheduling, a REST API, webhook and integration support, automatic proxy rotation, and run monitoring without maintaining any infrastructure yourself.

The scraper has **two modes**. Without a VK access token it scrapes VK's public HTML, which returns text, dates, and media links. With a token it uses the official VK API and returns everything — engagement counts, author profiles, comment threads, polls, and geotags. See [Extraction modes](#extraction-modes) for exactly which fields each mode fills.

## Why use VK Posts Scraper?

- **Competitor and brand monitoring** — track what communities in your market publish, and how often.
- **Content research** — pull a community's back catalogue to analyse topics, formats, and posting cadence.
- **Media and archival work** — capture posts with their attachment URLs before they change or disappear.
- **Dataset building** — collect Russian-language social text for analysis, with exact timestamps.
- **Feeding other tools** — schedule runs and push results to Google Sheets, S3, a webhook, or your own API.

## How to use VK Posts Scraper

1. Click **Try for free** (or **Start** if you already have it).
2. In the **Input** tab, add one or more targets to **VK targets** — for example `kinopoisk`, `https://vk.com/durov`, or `-220754053`.
3. *(Recommended)* Paste a **VK access token**. This unlocks engagement counts, authors, and comments. See [Getting an access token](#getting-an-access-token).
4. Set **Maximum posts** to control how much you collect.
5. Click **Start** and wait — most runs finish in under a minute.
6. Open the **Output** tab, or download the dataset as JSON, CSV, Excel, or HTML.

## Input

Configure everything from the **Input** tab. Only `vkTargets` is required.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `vkTargets` | array | **required** | Handles (`durov`), profile/community URLs, signed owner IDs (`-220754053`), or post links (`https://vk.com/wall1_45678`). |
| `accessToken` | string (secret) | — | VK API token with the `wall` scope. Strongly recommended. |
| `maxItems` | integer | 500 | Total posts across all targets. |
| `postsPerTarget` | integer | — | Optional per-target cap. |
| `publishedAfter` | string | — | `YYYY-MM-DD` or ISO-8601. Pagination stops at older posts. |
| `publishedBefore` | string | — | `YYYY-MM-DD` or ISO-8601. A bare date includes the whole day. |
| `postFilter` | enum | `all` | `all`, `owner`, or `others`. API mode only. |
| `includeComments` | boolean | false | Fetch comment threads with replies. API mode only. |
| `maxComments` | integer | 100 | Comments per post when the above is on. |
| `keepUndatedPosts` | boolean | false | Keep posts whose date could not be read, even when a date filter is set. |
| `htmlTimezone` | string | `Europe/Moscow` | Timezone VK renders times in. HTML mode only. |
| `includeRawPost` | boolean | false | Attach the unmodified VK API object as `rawPost`. |
| `proxyConfiguration` | object | Residential | VK blocks most datacenter IPs. |

```json
{
    "vkTargets": ["https://vk.com/vkvideo", "kinopoisk"],
    "accessToken": "vk1.a.…",
    "maxItems": 200,
    "publishedAfter": "2026-01-01",
    "includeComments": true
}
```

## Output

One dataset item per post. You can download the dataset in various formats such as JSON, HTML, CSV, or Excel, or pull it through the Apify API.

```json
{
    "postId": "-220754053_278663",
    "ownerId": -220754053,
    "text": "Попали под чары Лены Журавлёвой и даже не сопротивляемся…",
    "postedAt": "2026-08-13T12:03:00.000Z",
    "sourceUrl": "https://vk.com/wall-220754053_278663",
    "stats": { "likes": 1240, "comments": 87, "reposts": 33, "views": 98000, "engagement": 1360 },
    "mediaTypes": ["photo"],
    "mediaCount": 6,
    "attachments": [
        { "type": "photo", "id": "-220754053_457265754", "url": "https://vk.com/photo-220754053_457265754" }
    ],
    "isRepost": false,
    "repostChain": [],
    "target": "https://vk.com/vkvideo",
    "targetType": "url",
    "scrapedAt": "2026-08-15T19:06:24.168Z"
}
```

### Data fields

| Field | Description |
| --- | --- |
| `postId` | VK identifier as `ownerId_postId`. |
| `ownerId` | Signed ID of the wall (negative for communities). |
| `author`, `authorId` | Who wrote the post. Differs from the wall owner on community posts. |
| `text` | Post body. |
| `postedAt`, `editedAt` | ISO-8601 timestamps in UTC. |
| `sourceUrl` | Canonical vk.com link. |
| `stats` | `likes`, `comments`, `reposts`, `views`, `engagement`. |
| `mediaTypes`, `mediaCount` | Attachment types and how many. |
| `attachments` | Photos, videos, audio, docs, links and polls with VK object IDs and URLs. |
| `isRepost`, `repostChain` | Whether the post reposts other content, and the originals. |
| `comments` | Comment threads with replies, when enabled. |
| `geo`, `isPinned`, `isAd`, `signer` | Post metadata. |
| `target`, `targetType` | Which input produced this row. |
| `scrapedAt` | When it was extracted. |

## Extraction modes

Field availability differs by mode. This table is the honest version — check it before you rely on a field.

| Field | HTML mode (no token) | API mode (with token) |
| --- | --- | --- |
| `text`, `postedAt`, `sourceUrl` | ✅ | ✅ |
| `attachments` with URLs and IDs | ✅ | ✅ (plus sizes, durations, titles) |
| `mediaTypes`, `isRepost`, `isPinned` | ✅ | ✅ |
| `stats` (likes, views, comments) | ⚠️ often `null` | ✅ |
| `author`, `wallOwner` | ❌ `null` | ✅ |
| `repostChain` contents | ❌ empty | ✅ |
| `comments` | ❌ | ✅ |
| Polls, geotags, `signer`, `isAd` | ❌ | ✅ |
| Whole wall depth | ⚠️ limited by VK | ✅ |
| Private walls your token can read | ❌ | ✅ |

**HTML mode is a convenience tier.** It is genuinely useful for text and media, but VK does not put engagement numbers in reliably-parseable public markup, so `stats` is frequently `null`. If you need engagement data, use a token.

Nothing is ever invented. A field VK does not provide is `null`, never a guess.

### Getting an access token

1. Create a standalone application at [dev.vk.com](https://dev.vk.com).
2. Open its settings and copy the **service access key**.
3. Paste it into the **VK access token** field. It is stored encrypted and never appears in logs.

This takes about two minutes and needs no OAuth flow. For walls only a user account can read, generate a user token with the `wall` scope instead.

## How much does it cost to scrape VK?

This Actor is billed by Apify platform usage (compute units, proxy traffic, storage). Runs are light: a browser is only launched in HTML mode, and API mode uses plain HTTP.

Rough guide from real runs:

- **30 posts, HTML mode** — around 15 seconds of a 4 GB run
- **500 posts, API mode** — a handful of HTTP requests, no browser

Keep costs down by setting `maxItems` to what you actually need, using a token so the run skips the browser entirely, and narrowing with `publishedAfter`.

## Tips and advanced options

- **Use a token.** It is faster, cheaper, more complete, and more reliable than HTML mode.
- **Residential proxies matter.** VK blocks most datacenter ranges. If runs fail to connect, set the proxy country to `RU` in **Proxy configuration**.
- **Date filters stop pagination early.** `publishedAfter` halts the crawl once older posts appear, so a narrow window is much cheaper than a wide one.
- **Undated posts are dropped when a date filter is set**, because they cannot be checked against it. Set `keepUndatedPosts: true` to keep them.
- **Scraping several communities?** Put them all in `vkTargets` — one run, deduplicated across targets.
- **Schedule it.** Use the Schedules tab for daily monitoring, and integrations to push results onward.

## FAQ

**Does this work without a VK account or token?**
Yes, in HTML mode — with the field limitations in the table above.

**Why is `stats` null on some posts?**
VK does not expose engagement counts in parseable public markup consistently. Use an access token for reliable numbers.

**Why did I get fewer posts than I asked for?**
VK limits how much of a wall it serves anonymously. The run log says so explicitly when it happens. A token lifts the limit.

**Are timestamps in my timezone?**
No — always UTC. In HTML mode, VK's displayed times are interpreted using `htmlTimezone` (Moscow by default) and converted to UTC.

**Can it scrape private profiles?**
No. Only public walls, or walls the supplied token can legitimately read. This Actor does not bypass VK's access controls.

## Legal and support

This Actor collects **publicly available data only**. You are responsible for how you use it, including compliance with VK's Terms of Service, GDPR, and any other applicable law. Scraping personal data may require a lawful basis — consult a lawyer if you are unsure. Do not use this Actor to collect personal data without a legitimate reason.

Found a bug or need a field that is missing? Open a ticket in the **Issues** tab. If you need a tailored VK dataset or a custom integration, get in touch through the same channel.
