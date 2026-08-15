import { CheerioCrawler } from '@crawlee/cheerio';
import { PlaywrightCrawler } from '@crawlee/playwright';
import { describe, expect, it, vi } from 'vitest';

import { buildApiCrawlerOptions, buildHtmlCrawlerOptions, isNavigationFailure, swapVkHost } from '../src/crawler-options.js';

const config = { htmlTimezone: 'Europe/Moscow' };
const router = Object.assign(vi.fn(), { classifyError: () => ({ retry: true }) });

/**
 * Crawlee validates its options and throws on an unknown key, so simply
 * constructing the crawlers proves every option is spelled correctly and sits at
 * the right nesting level. `retireBrowserAfterPageCount` on the crawler instead
 * of inside `browserPoolOptions` once failed every run three seconds in.
 */
describe('crawler options', () => {
    it('are accepted by CheerioCrawler', () => {
        expect(() => new CheerioCrawler(buildApiCrawlerOptions({ router }))).not.toThrow();
    });

    it('are accepted by PlaywrightCrawler', () => {
        expect(() => new PlaywrightCrawler(buildHtmlCrawlerOptions({ router, config }))).not.toThrow();
    });

    it('pins the browser timezone so VK renders times predictably', () => {
        const options = buildHtmlCrawlerOptions({ router, config: { htmlTimezone: 'Asia/Tokyo' } });
        expect(options.launchContext.launchOptions.timezoneId).toBe('Asia/Tokyo');
    });

    it('navigates on domcontentloaded, since VK never fires load', async () => {
        const gotoOptions = {};
        await buildHtmlCrawlerOptions({ router, config }).preNavigationHooks[0]({}, gotoOptions);
        expect(gotoOptions.waitUntil).toBe('domcontentloaded');
    });
});

describe('isNavigationFailure', () => {
    it.each([
        'page.goto: Timeout 45000ms exceeded.',
        'net::ERR_CONNECTION_CLOSED at https://m.vk.com/vkvideo',
        'net::ERR_TUNNEL_CONNECTION_FAILED',
        'connect ECONNREFUSED 1.2.3.4:443',
        'getaddrinfo EAI_AGAIN m.vk.com',
    ])('treats %s as a proxy problem', (message) => {
        expect(isNavigationFailure(new Error(message))).toBe(true);
    });

    it.each([
        'Wall rendered but no posts could be parsed',
        'Every post found belonged to a different community',
    ])('does not treat %s as a proxy problem', (message) => {
        expect(isNavigationFailure(new Error(message))).toBe(false);
    });

    it('survives a missing message', () => {
        expect(isNavigationFailure(undefined)).toBe(false);
        expect(isNavigationFailure({})).toBe(false);
    });
});

describe('swapVkHost', () => {
    it('swaps mobile for desktop and back', () => {
        expect(swapVkHost('https://m.vk.com/vkvideo')).toBe('https://vk.com/vkvideo');
        expect(swapVkHost('https://vk.com/wall-1?offset=20')).toBe('https://m.vk.com/wall-1?offset=20');
    });

    it('leaves unrelated hosts alone', () => {
        expect(swapVkHost('https://example.com/vk.com')).toBe('https://example.com/vk.com');
    });
});

describe('html error handler', () => {
    const runErrorHandler = ({ url, retryCount, error }) => {
        const request = { url, retryCount, userData: { target: 'vkvideo' } };
        const session = { retire: vi.fn() };
        buildHtmlCrawlerOptions({ router, config }).errorHandler({ request, session }, error);
        return { request, session };
    };

    it('retires the proxy session on a network failure', () => {
        const { session } = runErrorHandler({
            url: 'https://m.vk.com/vkvideo', retryCount: 0, error: new Error('net::ERR_CONNECTION_CLOSED'),
        });
        expect(session.retire).toHaveBeenCalled();
    });

    it('leaves the session alone when the page loaded but parsing failed', () => {
        const { session } = runErrorHandler({
            url: 'https://m.vk.com/vkvideo', retryCount: 3, error: new Error('no posts could be parsed'),
        });
        expect(session.retire).not.toHaveBeenCalled();
    });

    it('keeps the same host for the first couple of attempts', () => {
        const { request } = runErrorHandler({
            url: 'https://m.vk.com/vkvideo', retryCount: 1, error: new Error('Timeout 30000ms exceeded'),
        });
        expect(request.url).toBe('https://m.vk.com/vkvideo');
    });

    it('falls back to the desktop host once mobile keeps failing', () => {
        const { request } = runErrorHandler({
            url: 'https://m.vk.com/vkvideo', retryCount: 2, error: new Error('Timeout 30000ms exceeded'),
        });
        expect(request.url).toBe('https://vk.com/vkvideo');
    });
});
