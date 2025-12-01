// Xing Jobs scraper - CheerioCrawler implementation (enhanced)
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

// Single-entrypoint main
await Actor.init();

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            keyword = '',
            location = '',
            discipline = '',
            results_wanted: RESULTS_WANTED_RAW = 100,
            max_pages: MAX_PAGES_RAW = 999,
            collectDetails = true,
            startUrl,
            startUrls,
            url,
            proxyConfiguration,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW)
            ? Math.max(1, +RESULTS_WANTED_RAW)
            : Number.MAX_SAFE_INTEGER;

        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW)
            ? Math.max(1, +MAX_PAGES_RAW)
            : 999;

        const toAbs = (href, base = 'https://www.xing.com') => {
            try {
                return new URL(href, base).href;
            } catch {
                return null;
            }
        };

        const cleanText = (html) => {
            if (!html) return '';
            const $ = cheerioLoad(html);
            $('script, style, noscript, iframe').remove();
            return $.root().text().replace(/\s+/g, ' ').trim();
        };

        const normalizeText = (str) => {
            if (!str) return null;
            return String(str).replace(/\s+/g, ' ').trim() || null;
        };

        const buildStartUrl = (kw, loc, disc) => {
            let path = '/jobs';
            if (kw) {
                path += `/t-${encodeURIComponent(
                    String(kw).trim().toLowerCase().replace(/\s+/g, '-'),
                )}`;
            }
            const u = new URL(path, 'https://www.xing.com');
            if (kw) u.searchParams.set('keywords', String(kw).trim());
            if (loc) u.searchParams.set('location', String(loc).trim());
            if (disc) u.searchParams.set('discipline', String(disc).trim());
            return u.href;
        };

        const initial = [];
        if (Array.isArray(startUrls) && startUrls.length) initial.push(...startUrls);
        if (startUrl) initial.push(startUrl);
        if (url) initial.push(url);
        if (!initial.length) initial.push(buildStartUrl(keyword, location, discipline));

        const proxyConf = proxyConfiguration
            ? await Actor.createProxyConfiguration({ ...proxyConfiguration })
            : undefined;

        let saved = 0;

        function extractFromJsonLd($) {
            const scripts = $('script[type="application/ld+json"]');
            for (let i = 0; i < scripts.length; i++) {
                try {
                    const parsed = JSON.parse($(scripts[i]).html() || '');
                    const arr = Array.isArray(parsed) ? parsed : [parsed];
                    for (const e of arr) {
                        if (!e) continue;
                        const t = e['@type'] || e.type;
                        if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) {
                            return {
                                title: e.title || e.name || null,
                                company: e.hiringOrganization?.name || null,
                                date_posted: e.datePosted || null,
                                description_html: e.description || null,
                                location:
                                    (e.jobLocation &&
                                        e.jobLocation.address &&
                                        (e.jobLocation.address.addressLocality ||
                                            e.jobLocation.address.addressRegion)) ||
                                    null,
                                salary: e.baseSalary
                                    ? e.baseSalary.value?.value ||
                                      e.baseSalary.minValue ||
                                      e.baseSalary.maxValue ||
                                      null
                                    : null,
                                job_type: e.employmentType || null,
                                remote_type: e.jobLocationType || null, // TELECOMMUTE, HYBRID, etc.
                            };
                        }
                    }
                } catch (e) {
                    // ignore JSON-LD parsing errors
                }
            }
            return null;
        }

        function findJobLinks($, base) {
            const links = new Set();
            $('a[href]').each((_, a) => {
                const href = $(a).attr('href');
                if (!href) return;
                // Xing job URLs pattern: /jobs/[location]-[title]-[id] or /jobs/homeoffice-[title]-[id]
                if (/\/jobs\/[a-z0-9-]+-\d+/i.test(href)) {
                    const abs = toAbs(href, base);
                    if (abs) links.add(abs);
                }
            });
            return [...links];
        }

        function findNextPage($, base) {
            // Xing uses "Show more" button or pagination
            const showMore = $('button')
                .filter((_, el) => /show\s+more/i.test($(el).text()))
                .first();
            if (showMore.length) {
                // Construct next page URL based on page param
                const currentUrl = new URL(base);
                const currentPage = parseInt(currentUrl.searchParams.get('page') || '1', 10);
                currentUrl.searchParams.set('page', String(currentPage + 1));
                return currentUrl.href;
            }
            return null;
        }

        const USER_AGENTS = [
            // A small realistic rotation – add more if you like
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
        ];
        const pickRandomUserAgent = () =>
            USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

        const crawler = new CheerioCrawler({
            proxyConfiguration: proxyConf,
            maxRequestRetries: 3,
            useSessionPool: true,
            sessionPoolOptions: {
                maxPoolSize: 100,
                sessionOptions: {
                    maxUsageCount: 50,
                },
            },
            maxConcurrency: 10,
            minConcurrency: 5,
            autoscaledPoolOptions: {
                desiredConcurrency: 10,
            },
            requestHandlerTimeoutSecs: 60,
            // Stealth: tweak headers & small delay before each request
            preNavigationHooks: [
                async ({ request, session }, gotOptions) => {
                    // Rotate User-Agent per session or request
                    const ua =
                        (session && session.userData && session.userData.ua) ||
                        pickRandomUserAgent();
                    if (session && session.userData && !session.userData.ua) {
                        session.userData.ua = ua;
                    }

                    gotOptions.headers = {
                        ...(gotOptions.headers || {}),
                        'User-Agent': ua,
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                        'Upgrade-Insecure-Requests': '1',
                        'Cache-Control': 'no-cache',
                        Pragma: 'no-cache',
                    };

                    // Human-like jitter
                    const delayMs = 150 + Math.random() * 450;
                    await Actor.sleep(delayMs);
                },
            ],
            failedRequestHandler: async ({ request, error }) => {
                log.error(
                    `Request ${request.url} failed too many times. Last error: ${error?.message}`,
                );
            },
            async requestHandler({ request, $, enqueueLinks, log: crawlerLog }) {
                const label = request.userData?.label || 'LIST';
                const pageNo = request.userData?.pageNo || 1;

                if (label === 'LIST') {
                    const links = findJobLinks($, request.url);
                    crawlerLog.info(`LIST ${request.url} -> found ${links.length} job links`);

                    if (collectDetails) {
                        const remaining = RESULTS_WANTED - saved;
                        const toEnqueue = links.slice(0, Math.max(0, remaining));
                        if (toEnqueue.length) {
                            await enqueueLinks({
                                urls: toEnqueue,
                                userData: { label: 'DETAIL' },
                            });
                        }
                    } else {
                        const remaining = RESULTS_WANTED - saved;
                        const toPush = links.slice(0, Math.max(0, remaining));
                        if (toPush.length) {
                            await Dataset.pushData(
                                toPush.map((u) => ({ url: u, _source: 'xing.com' })),
                            );
                            saved += toPush.length;
                        }
                    }

                    if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                        const next = findNextPage($, request.url);
                        if (next) {
                            await enqueueLinks({
                                urls: [next],
                                userData: { label: 'LIST', pageNo: pageNo + 1 },
                            });
                        }
                    }
                    return;
                }

                // DETAIL pages
                if (label === 'DETAIL') {
                    if (saved >= RESULTS_WANTED) return;
                    try {
                        const json = extractFromJsonLd($);
                        const data = json || {};

                        // Title
                        if (!data.title) {
                            data.title = normalizeText(
                                $('h1, [data-testid="job-title"], .job-title')
                                    .first()
                                    .text(),
                            );
                        }

                        // Company
                        if (!data.company) {
                            const companyEl = $(
                                '[data-testid="company-name"], .company-name, [class*="company"]',
                            ).first();
                            data.company = normalizeText(companyEl.text());
                        }

                        // Description HTML / text
                        if (!data.description_html) {
                            const desc = $(
                                '[data-testid="job-description"], [class*="job-description"], .description, article',
                            ).first();
                            data.description_html = desc && desc.length ? String(desc.html()).trim() : null;
                        }
                        data.description_text = data.description_html
                            ? cleanText(data.description_html)
                            : null;

                        // Location
                        if (!data.location) {
                            const locEl = $(
                                '[data-testid="job-location"], [class*="location"], .location',
                            ).first();
                            data.location = normalizeText(locEl.text());
                        }

                        // Salary – your CSS selector fallback
                        if (!data.salary) {
                            // Generic salary selectors
                            const salaryElGeneric = $(
                                '[data-testid="salary"], [class*="salary"]',
                            ).first();
                            let salaryText = normalizeText(salaryElGeneric.text());

                            // Specific CSS selector you provided
                            if (!salaryText) {
                                const salarySelector =
                                    'span.body-copy-styles__BodyCopy-sc-b3916c1b-0.dLgVbf.marker-styles__Text-sc-f046032b-2.bGmnFj';
                                const salaryCand = $(salarySelector).eq(0); // first occurrence
                                salaryText = normalizeText(salaryCand.text()) || salaryText;
                            }

                            data.salary = salaryText || data.salary || null;
                        }

                        // Job type – your CSS selector fallback
                        if (!data.job_type) {
                            // Generic job type selectors
                            const typeEl = $(
                                '[data-testid="employment-type"], [class*="employment-type"]',
                            ).first();
                            let typeText = normalizeText(typeEl.text());

                            // Specific CSS selector you provided for job type
                            if (!typeText) {
                                const jobTypeSelector =
                                    'span.aria-extended-text__Text-sc-a2c0913c-0.gmPLC';
                                const jtEl = $(jobTypeSelector).first();
                                typeText = normalizeText(jtEl.text()) || typeText;
                            }

                            data.job_type = typeText || data.job_type || null;
                        }

                        // Remote type (e.g. Remote, Hybrid, On-site) – using your selector
                        if (!data.remote_type) {
                            // Schema.org jobLocationType already handled above as json.remote_type
                            const remoteSelector =
                                'span.body-copy-styles__BodyCopy-sc-b3916c1b-0.dLgVbf.marker-styles__Text-sc-f046032b-2.bGmnFj';

                            const elems = $(remoteSelector);
                            let remoteText = null;

                            // Heuristic: often salary and remote are rendered in the same style,
                            // so take the second or last occurrence as "remote" if available.
                            if (elems.length > 1) {
                                remoteText = normalizeText(elems.last().text());
                            }

                            data.remote_type = remoteText || data.remote_type || null;
                        }

                        const item = {
                            title: data.title || null,
                            company: data.company || null,
                            discipline: discipline || null,
                            location: data.location || null,
                            salary: data.salary || null,
                            job_type: data.job_type || null,
                            remote: data.remote_type || null, // exposed field for remote / hybrid / onsite
                            date_posted: data.date_posted || null,
                            description_html: data.description_html || null,
                            description_text: data.description_text || null,
                            url: request.url,
                        };

                        await Dataset.pushData(item);
                        saved++;

                        // Optional debugging logs (can be downgraded to debug)
                        if (!item.salary || !item.job_type || !item.remote) {
                            crawlerLog.debug(
                                `DETAIL missing some fields at ${request.url} :: salary="${item.salary}" job_type="${item.job_type}" remote="${item.remote}"`,
                            );
                        }
                    } catch (err) {
                        crawlerLog.error(`DETAIL ${request.url} failed: ${err.message}`);
                    }
                }
            },
        });

        await crawler.run(
            initial.map((u) => ({
                url: u,
                userData: { label: 'LIST', pageNo: 1 },
            })),
        );
        log.info(`Finished. Saved ${saved} items`);
    } finally {
        await Actor.exit();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
