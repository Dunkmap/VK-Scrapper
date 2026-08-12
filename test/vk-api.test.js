import { describe, expect, it } from 'vitest';

import { buildApiRequest, parseDateBoundary, unwrapApiResponse,VkApiError } from '../src/vk-api.js';

describe('buildApiRequest', () => {
    const request = buildApiRequest('wall.get', { domain: 'durov', offset: 0, count: 100, skipped: null }, 'secret-token', { target: 'durov' }, 'wall:durov:0');

    it('POSTs to the official endpoint', () => {
        expect(request.url).toBe('https://api.vk.com/method/wall.get');
        expect(request.method).toBe('POST');
    });

    it('keeps the access token out of the URL', () => {
        expect(request.url).not.toContain('secret-token');
        expect(request.uniqueKey).not.toContain('secret-token');
        expect(request.payload).toContain('access_token=secret-token');
    });

    it('sends the pinned API version and drops null params', () => {
        const params = new URLSearchParams(request.payload);
        expect(params.get('v')).toBe('5.199');
        expect(params.get('domain')).toBe('durov');
        expect(params.has('skipped')).toBe(false);
    });

    it('carries userData and the method name through', () => {
        expect(request.userData).toEqual({ target: 'durov', method: 'wall.get' });
    });
});

describe('unwrapApiResponse', () => {
    it('returns the response payload', () => {
        expect(unwrapApiResponse({ response: { count: 2, items: [] } }, 'wall.get')).toEqual({ count: 2, items: [] });
    });

    it('throws a VkApiError carrying the code', () => {
        const call = () => unwrapApiResponse({ error: { error_code: 15, error_msg: 'Access denied' } }, 'wall.get');
        expect(call).toThrow(VkApiError);
        try {
            call();
        } catch (error) {
            expect(error.code).toBe(15);
            expect(error.isRetryable).toBe(false);
            expect(error.isFatal).toBe(false);
        }
    });

    it('flags rate limiting as retryable', () => {
        try {
            unwrapApiResponse({ error: { error_code: 6, error_msg: 'Too many requests per second' } }, 'wall.get');
        } catch (error) {
            expect(error.isRetryable).toBe(true);
        }
    });

    it('flags a dead token as fatal', () => {
        try {
            unwrapApiResponse({ error: { error_code: 5, error_msg: 'User authorization failed' } }, 'wall.get');
        } catch (error) {
            expect(error.isFatal).toBe(true);
        }
    });

    it.each([null, 'not json', {}, { something: 1 }])('rejects a non-envelope body %s', (body) => {
        expect(() => unwrapApiResponse(body, 'wall.get')).toThrow();
    });
});

describe('parseDateBoundary', () => {
    it('snaps a bare start date to midnight UTC', () => {
        expect(parseDateBoundary('2024-01-15', 'start', 'publishedAfter').toISOString())
            .toBe('2024-01-15T00:00:00.000Z');
    });

    it('snaps a bare end date to the end of that day so the day is included', () => {
        expect(parseDateBoundary('2024-01-15', 'end', 'publishedBefore').toISOString())
            .toBe('2024-01-15T23:59:59.999Z');
    });

    it('passes full ISO timestamps through', () => {
        expect(parseDateBoundary('2024-01-15T12:30:00Z', 'end', 'publishedBefore').toISOString())
            .toBe('2024-01-15T12:30:00.000Z');
    });

    it.each([null, undefined, ''])('returns null for %s', (value) => {
        expect(parseDateBoundary(value, 'start', 'publishedAfter')).toBeNull();
    });

    it('throws on garbage', () => {
        expect(() => parseDateBoundary('yesterday', 'start', 'publishedAfter')).toThrow(/Invalid "publishedAfter"/);
    });
});
