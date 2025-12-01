// Xing Jobs scraper - CheerioCrawler implementation (production-ready)
// Uses Crawlee's `sleep` (no Actor.sleep) and parses salary into a clean string.

import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset, sleep } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

Actor.main(async () => {
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

    // --- NEW: salary text parser to remove messy wording and extract numbers ---
    const parseSalaryText = (raw) => {
        if (!raw) return null;

        let text = String(raw).replace(/\s+/g, ' ').trim();

        // Strip everything before first currency sign (removes "Salary forecastHow forecasts are calculated")
        const firstCurrencyIndex = text.search(/[€£$]/);
        if (firstCurrencyIndex > 0) {
            text = text.slice(firstCurrencyIndex).trim();
        }

        // Grab all currency-like amounts: €52,500, €44.500, etc.
        const matches = text.match(/[€£$]\s?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?/g);
        if (!matches || !matches.length) {
            // If we can't parse, just return the cleaned text as a last resort
            return text;
        }

        // Deduplicate while preserving order
        const uniques = Array.from(new Set(matches));

        if (uniques.length === 1) {
            // Single amount: just return it
            return uniques[0];
        }

        if (uniques.length === 2) {
            // Two amounts: assume range
            const [min, max] = uniques;
            return `${min}–${max}`;
        }

        // 3+ amounts: commonly [avg, min, max] pattern
        const avg = uniques[0];
        const min = uniques[1];
        const max = uniques[uniques.length - 1];

        return `${avg} avg, range ${min}–${max}`;
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

    // ----- JSON-LD extraction -----
    function extractFromJsonLd($) {
        const scripts = $('script[type="application/ld+json"]');
        for (let i = 0; i < scripts.length; i++) {
            try {
                const raw = $(scripts[i]).html() || '';
                if (!raw.trim()) continue;

                const parsed = JSON.parse(raw);
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
                            remote_type: e.jobLocationType || null, // TELECOMMUTE / HYBRID / etc.
                            job_category: null,
                        };
                    }
                }
            } catch {
                // ignore JSON-LD parsing errors
            }
        }
        return null;
    }

    // ----- LIST page helpers -----
    function findJobLinks($, base) {
        const links = new Set();
        $('a[href]').each((_, a) => {
            const href = $(a).attr('href');
            if (!href) return;

            // Xing job URLs pattern: /jobs/[slug]-[id]
            if (/\/jobs\/[a-z0-9-]+-\d+/i.test(href)) {
                const abs = toAbs(href, base);
                if (abs) links.add(abs);
            }
        });
        return [...links];
    }

    function findNextPage($, base) {
        const showMore = $('button')
            .filter((_, el) => /show\s+more/i.test($(el).text()))
            .first();
        if (showMore.length) {
            const currentUrl = new URL(base);
            const currentPage = parseInt(currentUrl.searchParams.get('page') || '1', 10);
            currentUrl.searchParams.set('page', String(currentPage + 1));
            return currentUrl.href;
        }

        const nextLink = $('a[aria-label*="Next"], a[rel="next"]').first();
        if (nextLink.length) {
            const abs = toAbs(nextLink.attr('href'), base);
            if (abs) return abs;
        }

        return null;
    }

    // ----- Stealth: UA rotation -----
    const USER_AGENTS = [
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

        // Performance
        minConcurrency: 5,
        maxConcurrency: 10,
        autoscaledPoolOptions: {
            desiredConcurrency: 10,
        },

        requestHandlerTimeoutSecs: 60,

        preNavigationHooks: [
            async ({ session }, gotOptions) => {
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
                    Accept:
                        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Upgrade-Insecure-Requests': '1',
                    'Cache-Control': 'no-cache',
                    Pragma: 'no-cache',
                };

                const delayMs = 150 + Math.random() * 450;
                await sleep(delayMs);
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

            // ---------- LIST PAGES ----------
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

            // ---------- DETAIL PAGES ----------
            if (label === 'DETAIL') {
                if (saved >= RESULTS_WANTED) return;

                try {
                    const json = extractFromJsonLd($);
                    const data = json || {};

                    // Title
                    if (!data.title) {
                        data.title = normalizeText(
                            $('h1, [data-testid="job-title"], .job-title').first().text(),
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

                    // ----- Salary (use parser to make it clean) -----
                    if (!data.salary) {
                        const salaryGeneric = $(
                            '[data-testid="salary"], [class*="salary"]',
                        ).first();

                        let rawSalaryText = salaryGeneric.text() || '';

                        // Specific CSS selector you provided, first element = salary
                        if (!rawSalaryText) {
                            const salarySelector =
                                'span.body-copy-styles__BodyCopy-sc-b3916c1b-0.dLgVbf.marker-styles__Text-sc-f046032b-2.bGmnFj';
                            const salaryCand = $(salarySelector).eq(0);
                            rawSalaryText = salaryCand.text() || rawSalaryText;
                        }

                        const parsedSalary = parseSalaryText(rawSalaryText);
                        data.salary =
                            parsedSalary ||
                            normalizeText(rawSalaryText) ||
                            data.salary ||
                            null;
                    }

                    // ----- Job type (your selector as fallback) -----
                    if (!data.job_type) {
                        const typeEl = $(
                            '[data-testid="employment-type"], [class*="employment-type"]',
                        ).first();
                        let typeText = normalizeText(typeEl.text());

                        if (!typeText) {
                            const jobTypeSelector =
                                'span.aria-extended-text__Text-sc-a2c0913c-0.gmPLC';
                            const jtEl = $(jobTypeSelector).first();
                            typeText = normalizeText(jtEl.text()) || typeText;
                        }

                        data.job_type = typeText || data.job_type || null;
                    }

                    // ----- Remote (your selector as fallback) -----
                    if (!data.remote_type) {
                        const remoteSelector =
                            'span.body-copy-styles__BodyCopy-sc-b3916c1b-0.dLgVbf.marker-styles__Text-sc-f046032b-2.bGmnFj';
                        const elems = $(remoteSelector);

                        let remoteText = null;
                        if (elems.length > 1) {
                            remoteText = normalizeText(elems.last().text());
                        }

                        data.remote_type = remoteText || data.remote_type || null;
                    }

                    // ----- Job category (your selector) -----
                    if (!data.job_category) {
                        const jobCategorySelector =
                            'p.body-copy-styles__BodyCopy-sc-b3916c1b-0.gIutZc.job-intro__AdditionalInfo-sc-5658992b-1.hDMxHz';
                        const jcEl = $(jobCategorySelector).first();
                        data.job_category = normalizeText(jcEl.text()) || null;
                    }

                    const item = {
                        title: data.title || null,
                        company: data.company || null,
                        discipline: discipline || null,
                        location: data.location || null,
                        salary: data.salary || null,        // <- clean, readable salary
                        job_type: data.job_type || null,
                        remote: data.remote_type || null,
                        job_category: data.job_category || null,
                        date_posted: data.date_posted || null,
                        description_html: data.description_html || null,
                        description_text: data.description_text || null,
                        url: request.url,
                    };

                    await Dataset.pushData(item);
                    saved++;

                    if (!item.salary || !item.job_type || !item.remote || !item.job_category) {
                        crawlerLog.debug(
                            `DETAIL missing fields at ${request.url} :: ` +
                                `salary="${item.salary}" job_type="${item.job_type}" ` +
                                `remote="${item.remote}" job_category="${item.job_category}"`,
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
});
