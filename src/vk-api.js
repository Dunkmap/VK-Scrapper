/**
 * Thin helpers around the official VK API (https://dev.vk.com/method).
 *
 * Requests are issued as POST with a form-encoded body so the access token
 * never lands in a request URL, request queue record or log line.
 */

export const VK_API_VERSION = '5.199';
export const VK_API_BASE = 'https://api.vk.com/method';

/** wall.get / wall.getComments hard cap. */
export const MAX_PAGE_SIZE = 100;

/** VK error codes that are transient - worth retrying the same request. */
const RETRYABLE_ERROR_CODES = new Set([1, 6, 10]);

/** VK error codes that mean "this token is unusable" - abort the whole run. */
const FATAL_ERROR_CODES = new Set([5, 27, 28, 29]);

/**
 * Thrown for a VK-level error (HTTP 200 with an `error` body).
 */
export class VkApiError extends Error {
    /**
     * @param {{error_code?: number, error_msg?: string}} error
     * @param {string} method
     */
    constructor(error, method) {
        super(`VK API ${method} failed [${error?.error_code ?? '?'}]: ${error?.error_msg ?? 'unknown error'}`);
        this.name = 'VkApiError';
        this.code = error?.error_code ?? null;
        this.method = method;
        this.isRetryable = RETRYABLE_ERROR_CODES.has(this.code);
        this.isFatal = FATAL_ERROR_CODES.has(this.code);
    }
}

/**
 * Builds the Crawlee request descriptor for a VK API method call.
 *
 * @param {string} method e.g. `wall.get`
 * @param {Record<string, string|number|undefined|null>} params Method params, minus auth/version.
 * @param {string} accessToken
 * @param {object} userData Carried through to the route handler.
 * @param {string} uniqueKey Distinguishes paginated POSTs that share a URL.
 * @returns {import('@crawlee/cheerio').RequestOptions}
 */
export const buildApiRequest = (method, params, accessToken, userData, uniqueKey) => {
    const body = new URLSearchParams({ v: VK_API_VERSION, access_token: accessToken });
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) body.set(key, String(value));
    }

    return {
        url: `${VK_API_BASE}/${method}`,
        method: 'POST',
        uniqueKey,
        payload: body.toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        userData: { ...userData, method },
        // The token is request-specific state, not part of the crawl identity.
        skipNavigation: false,
    };
};

/**
 * Validates a VK API response envelope and returns its `response` payload.
 *
 * @param {unknown} payload Parsed JSON body.
 * @param {string} method
 * @returns {object}
 * @throws {VkApiError} When VK reported an error.
 * @throws {Error} When the body is not a VK envelope at all.
 */
export const unwrapApiResponse = (payload, method) => {
    if (!payload || typeof payload !== 'object') {
        throw new Error(`VK API ${method} returned a non-JSON body - the request was probably blocked.`);
    }
    if ('error' in payload) throw new VkApiError(payload.error, method);
    if (!('response' in payload)) {
        throw new Error(`VK API ${method} returned no "response" field - the request was probably blocked.`);
    }
    return payload.response;
};

/**
 * Parses a `YYYY-MM-DD` (or any Date-parseable) boundary from the input schema.
 *
 * @param {string|null|undefined} value
 * @param {'start'|'end'} edge `end` snaps a bare date to the end of that day.
 * @param {string} fieldName For the error message.
 * @returns {Date|null}
 */
export const parseDateBoundary = (value, edge, fieldName) => {
    if (value === null || value === undefined || value === '') return null;

    const isBareDate = /^\d{4}-\d{2}-\d{2}$/.test(String(value).trim());
    const iso = isBareDate
        ? `${String(value).trim()}T${edge === 'end' ? '23:59:59.999' : '00:00:00.000'}Z`
        : String(value);

    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        throw new Error(`Invalid "${fieldName}" value: "${value}". Use YYYY-MM-DD or a full ISO-8601 timestamp.`);
    }
    return date;
};
