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
                                remote_type: e.jobLocationType || null,
                                job_category: null, // JSON-LD rarely includes it
                            };
                        }
                    }
                } catch (e) {}
            }
            return null;
        }

        function findJobLinks($, base) {
            const links = new Set();
            $('a[href]').each((_, a) => {
                const href = $(a).attr('href');
                if (!href) return;
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
            return null;
        }

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
            maxConcurrency: 10,
            minConcurrency: 5,
            autoscaledPoolOptions: { desiredConcurrency: 10 },
            requestHandlerTimeoutSecs: 60,

            preNavigationHooks: [
                async ({ request, session }, gotOptions) => {
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
                        'Accept':
                            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                        'Upgrade-Insecure-Requests': '1',
                        'Cache-Control': 'no-cache',
                        Pragma: 'no-cache',
                    };
                    await Actor.sleep(150 + Math.random() * 450);
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
                    crawlerLog.info(`LIST ${request.url} -> ${links.length} jobs`);

                    if (collectDetails) {
                        const remaining = RESULTS_WANTED - saved;
                        await enqueueLinks({
                            urls: links.slice(0, remaining),
                            userData: { label: 'DETAIL' },
                        });
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

                // DETAIL
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
                            data.company = normalizeText(
                                $('[data-testid="company-name"], .company-name')
                                    .first()
                                    .text(),
                            );
                        }

                        // Description
                        if (!data.description_html) {
                            const desc = $(
                                '[data-testid="job-description"], .description, article',
                            ).first();
                            data.description_html = desc.html() || null;
                        }
                        data.description_text = data.description_html
                            ? cleanText(data.description_html)
                            : null;

                        // Location
                        if (!data.location) {
                            data.location = normalizeText(
                                $('[data-testid="job-location"], .location').first().text(),
                            );
                        }

                        // Salary
                        if (!data.salary) {
                            const sel =
                                'span.body-copy-styles__BodyCopy-sc-b3916c1b-0.dLgVbf.marker-styles__Text-sc-f046032b-2.bGmnFj';
                            data.salary = normalizeText($(sel).first().text()) || null;
                        }

                        // Job type
                        if (!data.job_type) {
                            const sel =
                                'span.aria-extended-text__Text-sc-a2c0913c-0.gmPLC';
                            data.job_type = normalizeText($(sel).first().text()) || null;
                        }

                        // Remote
                        if (!data.remote_type) {
                            const sel =
                                'span.body-copy-styles__BodyCopy-sc-b3916c1b-0.dLgVbf.marker-styles__Text-sc-f046032b-2.bGmnFj';
                            if ($(sel).length > 1) {
                                data.remote_type = normalizeText($(sel).last().text());
                            }
                        }

                        // ⭐ NEW — Job Category
                        if (!data.job_category) {
                            const sel =
                                'p.body-copy-styles__BodyCopy-sc-b3916c1b-0.gIutZc.job-intro__AdditionalInfo-sc-5658992b-1.hDMxHz';
                            data.job_category = normalizeText($(sel).first().text()) || null;
                        }

                        await Dataset.pushData({
                            title: data.title || null,
                            company: data.company || null,
                            discipline: discipline || null,
                            location: data.location || null,
                            salary: data.salary || null,
                            job_type: data.job_type || null,
                            remote: data.remote_type || null,
                            job_category: data.job_category || null,
                            date_posted: data.date_posted || null,
                            description_html: data.description_html || null,
                            description_text: data.description_text || null,
                            url: request.url,
                        });

                        saved++;
                    } catch (err) {
                        crawlerLog.error(`DETAIL ${request.url} error: ${err.message}`);
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
