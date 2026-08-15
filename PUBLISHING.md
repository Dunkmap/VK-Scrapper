# Publishing checklist

Everything that lives in code is done. What remains can only be set in Apify Console.

## 1. Before you publish — recommended fixes

These are not blockers, but each one is something a paying user will notice in the first run.

| Issue | Why it matters | Effort |
| --- | --- | --- |
| `stats` is always `null` in HTML mode | Engagement counts are the most-requested field, and the competitor advertises them | Needs one diagnostic run to find VK's counter markup |
| `mediaCount` disagrees with `attachments.length` | Says 6 when the array holds 12, because thumbnails share the array | Small — move thumbnails to their own field |
| Polls are not detected | A poll post returns `mediaTypes: []` | Small |
| API mode never tested against real VK | It is half the product and completely unverified | One run with a token |

If you publish before fixing `stats`, the README's [Extraction modes](README.md#extraction-modes) table is what protects you — it states plainly that HTML mode often returns `null` there. Do not remove it.

## 2. Deploy

```bash
cd "c:/Users/manju/Downloads/source-code (1)"
apify push
```

Verify the build succeeds and run once before publishing.

## 3. Console → Settings

- **Name**: `vk-posts-scraper` (this becomes the URL: `apify.com/<your-username>/vk-posts-scraper`)
- **Title**: VK Posts Scraper
- **Description**: Scrape wall posts from public VK (VKontakte) profiles and communities: text, timestamps, attachment URLs, repost chains, engagement counts and comments.
- **Default run options**: 4096 MB memory, 300 s timeout is a sensible starting point

## 4. Console → Publication

- **Categories**: `Social media` (primary), optionally `News` or `E-commerce` if relevant
- **SEO title**: VK Posts Scraper — Extract VKontakte Wall Posts
- **SEO description**: Scrape public VK wall posts with text, dates, media URLs and engagement data. Export to JSON, CSV or Excel, or pull via API.
- **Categories and SEO fields are what Store search ranks on** — do not leave them blank
- Set **Maintained** if you intend to keep it working

## 5. Pricing

Set under **Publication → Monetization**. Reference points:

| Actor | Model | Price |
| --- | --- | --- |
| `maximedupre/vk-posts-scraper` | pay per result | **$3.60 / 1,000 posts** |
| `jupri/vkontakte` | pay per event | **$2.00 / 1,000 results** |

Options:

- **Free** — fastest way to gather users and reviews; you pay nothing, users pay platform usage
- **Pay per result** — $2.00–$3.00 / 1,000 posts undercuts both competitors while you have no track record
- **Rental** — a monthly fee; harder to sell without reviews

Recommendation: launch **free or cheap**. You have zero runs against a competitor with 6,043. Reviews and a success rate are worth more right now than margin.

## 6. Before you hit Publish

- [ ] `apify push` succeeded and the latest build is tagged `latest`
- [ ] At least one successful run visible in the Runs tab
- [ ] Input tab renders correctly, `accessToken` shows as a masked secret field
- [ ] Output tab shows the Overview, Media and Authors views
- [ ] README renders correctly in the Information tab
- [ ] Actor is set to **Public**
- [ ] `npm test` passes (222 tests) and `npm run lint` is clean

## 7. After publishing

- Watch the **Issues** tab; first-week bug reports are the highest-value signal you will get
- Track your success rate in **Runs** — the competitor's is 94.7%, that is the bar
- The `stats` gap will be the most common complaint. Fixing it is the single best follow-up.
