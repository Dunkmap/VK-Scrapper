import { Actor, log } from 'apify';

/**
 * Tracks the global item budget and de-duplicates posts across targets.
 *
 * `maxItems` in the input counts *posts*, not HTTP requests, so the budget has
 * to live outside the crawler and be checked on every push.
 */
export class ResultCollector {
    /**
     * @param {{ maxItems: number }} options
     */
    constructor({ maxItems }) {
        this.maxItems = maxItems;
        this.pushed = 0;
        this.seen = new Set();
    }

    /** @returns {boolean} True once the global budget is used up. */
    get isFull() {
        return this.pushed >= this.maxItems;
    }

    /** @returns {number} Remaining slots in the global budget. */
    get remaining() {
        return Math.max(0, this.maxItems - this.pushed);
    }

    /**
     * Has this post already been pushed (e.g. because two targets resolve to
     * the same wall, or a pinned post repeats on page two)?
     * @param {string|null} postId
     */
    isDuplicate(postId) {
        return postId !== null && this.seen.has(postId);
    }

    /**
     * Pushes items to the dataset, trimming to the remaining budget and
     * dropping duplicates.
     *
     * @param {object[]} items
     * @returns {Promise<number>} How many items were actually stored.
     */
    async push(items) {
        const fresh = [];
        for (const item of items) {
            if (this.pushed + fresh.length >= this.maxItems) break;
            if (this.isDuplicate(item.postId)) continue;
            if (item.postId !== null) this.seen.add(item.postId);
            fresh.push(item);
        }

        if (fresh.length === 0) return 0;

        await Actor.pushData(fresh);
        this.pushed += fresh.length;
        log.info(`Stored ${fresh.length} post(s). Total: ${this.pushed}/${this.maxItems}.`);
        return fresh.length;
    }
}
