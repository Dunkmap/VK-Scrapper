import { Actor } from 'apify';
import { PlaywrightCrawler } from '@crawlee/playwright';
import { router } from './routes.js';

await Actor.init();

const input = await Actor.getInput();
const { vkTargets, maxItems = 500 } = input;

const proxyConfiguration = await Actor.createProxyConfiguration();

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl: maxItems,
    requestHandler: router,
    // Soft navigation timeouts control karne ke liye
    navigationTimeoutSecs: 30,
    launchContext: {
        launchOptions: {
            args: [
                '--disable-gpu',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage'
            ],
        },
    },
});

const startRequests = vkTargets.map((target) => {
    let cleanTarget = target.trim();
    if (cleanTarget.startsWith('http')) {
        cleanTarget = cleanTarget.split('vk.com/').pop().replace('m.', '');
    }
    
    // Sabse lightweight dynamic security sub-page bypass link targeting
    return {
        url: `https://vk.com/dev/permissions?target_domain=${cleanTarget}`,
        userData: { originalTarget: target, domain: cleanTarget },
    };
});

await crawler.run(startRequests);
await Actor.exit();