import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('apify', () => ({
    log: {
        info: vi.fn(), warning: vi.fn(), error: vi.fn(), debug: vi.fn(), softFail: vi.fn(),
    },
}));

const { POST_SELECTOR, WALL_ROOT_SELECTOR, extractPostsInPage } = await import('../src/routes-html.js');

const SELECTORS = { postSelector: POST_SELECTOR, wallRootSelector: WALL_ROOT_SELECTOR };

/**
 * Markup modelled on what VK actually served: a "Show more" button inside the
 * text node, an emoji image alongside real photos, root-relative image URLs, a
 * repeated pinned post, and - outside the wall - a recommendation rail carrying
 * posts from other communities.
 */
const FIXTURE = `
<!doctype html>
<html><head><base href="https://vk.com/vkvideo"></head><body>
  <div id="wall_posts">
    <div class="_post post" data-post-id="-220754053_278529">
      <a class="PostHeaderSubtitle__link" href="/wall-220754053_278529" title="12 авг 2024 в 10:30">
        <span class="PostHeaderSubtitle__item">12 авг в 10:30</span>
      </a>
      <div class="wall_post_text">
        Что объединяет ST и Дороха?<img class="emoji" src="/emoji/e/f09f9881.png">Любовь к своим жёнам
        <span class="wall_post_more">Show more</span>
        совместный трек
      </div>
      <div class="page_post_sized_thumbs">
        <img src="/emoji/e/f09f9881.png">
        <img src="//sun9-1.userapi.com/impg/photo-a.jpg">
        <img data-src="https://sun9-2.userapi.com/impg/photo-b.jpg">
        <img src="data:image/gif;base64,R0lGOD">
        <img src="/images/icons/like.svg">
        <img src="//sun9-1.userapi.com/impg/photo-a.jpg">
      </div>
      <div class="PostBottomAction PostBottomAction--like"><span class="PostBottomAction__count">1 234</span></div>
      <div class="PostBottomAction PostBottomAction--views"><span class="PostBottomAction__count">98000</span></div>
    </div>

    <div class="_post post" data-post-id="-220754053_278500">
      <span class="rel_date" data-time="1700000000">14 ноя 2023</span>
      <div class="wall_post_text">Second post</div>
      <div class="copy_quote">quoted</div>
    </div>

    <!-- VK repeats a pinned post further down the wall, often with less markup. -->
    <div class="_post post" data-post-id="-220754053_278529">
      <div class="wall_post_text">Short</div>
    </div>
  </div>

  <!-- Recommendation rail: same markup, different communities, not this wall. -->
  <div class="recommendations">
    <div class="_post post" data-post-id="-217672812_12348">
      <div class="wall_post_text">Foreign community post</div>
    </div>
    <div class="_post post" data-post-id="-207536086_8577">
      <div class="wall_post_text">Another foreign post</div>
    </div>
  </div>
</body></html>`;

/** The same page with no recognisable wall container, forcing the fallback. */
const UNSCOPED_FIXTURE = `
<!doctype html>
<html><head><base href="https://vk.com/vkvideo"></head><body>
  <div class="feed">
    <div class="_post post" data-post-id="-220754053_1"><div class="wall_post_text">One</div></div>
    <div class="_post post" data-post-id="-217672812_2"><div class="wall_post_text">Foreign</div></div>
  </div>
</body></html>`;

describe('extractPostsInPage (real browser)', () => {
    let browser;
    let posts;
    let wasScoped;

    beforeAll(async () => {
        browser = await chromium.launch();
        const page = await browser.newPage();
        await page.setContent(FIXTURE);
        ({ posts, wasScoped } = await page.evaluate(extractPostsInPage, SELECTORS));
    }, 120_000);

    afterAll(async () => {
        await browser?.close();
    });

    it('reports that it found the wall container', () => {
        expect(wasScoped).toBe(true);
    });

    it('ignores posts outside the wall, whatever markup they use', () => {
        // Regression: recommendation rails leaked posts from other communities.
        const owners = new Set(posts.map((post) => post.ownerId));
        expect(owners).toEqual(new Set([-220754053]));
    });

    it('finds every post on the wall itself', () => {
        expect(posts).toHaveLength(2);
        expect(posts[0]).toMatchObject({ ownerId: -220754053, postId: 278529 });
    });

    it('returns each post once even when VK repeats the container', () => {
        const ids = posts.map((post) => `${post.ownerId}_${post.postId}`);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('keeps the richest copy of a duplicated post, not the last one seen', () => {
        const post = posts.find((candidate) => candidate.postId === 278529);
        expect(post.text).not.toBe('Short');
        expect(post.thumbnails.length).toBeGreaterThan(0);
    });

    it('strips the "Show more" button out of the post text', () => {
        expect(posts[0].text).not.toMatch(/Show more/);
        expect(posts[0].text).toContain('Что объединяет ST и Дороха?');
        expect(posts[0].text).toContain('совместный трек');
    });

    it('excludes emoji, sprites and data URIs from media', () => {
        expect(posts[0].thumbnails.some((url) => url.includes('/emoji/'))).toBe(false);
        expect(posts[0].thumbnails.some((url) => url.startsWith('data:'))).toBe(false);
        expect(posts[0].thumbnails.some((url) => url.endsWith('.svg'))).toBe(false);
    });

    it('returns absolute, de-duplicated media URLs', () => {
        expect(posts[0].thumbnails).toEqual([
            'https://sun9-1.userapi.com/impg/photo-a.jpg',
            'https://sun9-2.userapi.com/impg/photo-b.jpg',
        ]);
    });

    it('prefers the exact date from the title tooltip over the short label', () => {
        expect(posts[0].postedAtText).toBe('12 авг 2024 в 10:30');
    });

    it('reads a machine-readable timestamp when VK provides one', () => {
        expect(posts[1].postedAtUnix).toBe(1_700_000_000);
    });

    it('parses counters and rejects ambiguous ones', () => {
        // "1 234" uses a plain space here, so it is unambiguous once stripped.
        expect(posts[0].likes).toBe(1234);
        expect(posts[0].views).toBe(98_000);
        expect(posts[0].comments).toBeNull();
    });

    it('detects reposts', () => {
        expect(posts[0].isRepost).toBe(false);
        expect(posts[1].isRepost).toBe(true);
    });

    it('reports media types consistently with the thumbnails found', () => {
        expect(posts[0].mediaTypes).toContain('photo');
        expect(posts[1].mediaTypes).toEqual([]);
        expect(posts[1].thumbnails).toEqual([]);
    });

    it('falls back to the whole document when no wall container exists', async () => {
        const page = await browser.newPage();
        await page.setContent(UNSCOPED_FIXTURE);
        const result = await page.evaluate(extractPostsInPage, SELECTORS);

        // Scoping failed, so it says so and still returns what it found - the
        // owner filter downstream is what removes the foreign post.
        expect(result.wasScoped).toBe(false);
        expect(result.posts).toHaveLength(2);
        await page.close();
    });
});
