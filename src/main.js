// Xing Jobs scraper - CheerioCrawler implementation
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

// Single-entrypoint main
await Actor.init();

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            keyword = '', location = '', discipline = '', results_wanted: RESULTS_WANTED_RAW = 100,
            max_pages: MAX_PAGES_RAW = 999, collectDetails = true, startUrl, startUrls, url, proxyConfiguration,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : Number.MAX_SAFE_INTEGER;
        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 999;

        const toAbs = (href, base = 'https://www.xing.com') => {
            try { return new URL(href, base).href; } catch { return null; }
        };

        const cleanText = (html) => {
            if (!html) return '';
            const $ = cheerioLoad(html);
            $('script, style, noscript, iframe').remove();
            return $.root().text().replace(/\s+/g, ' ').trim();
        };

        const buildStartUrl = (kw, loc, disc) => {
            let path = '/jobs';
            if (kw) path += `/t-${encodeURIComponent(String(kw).trim().toLowerCase().replace(/\s+/g, '-'))}`;
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

        const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;

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
                                location: (e.jobLocation && e.jobLocation.address && (e.jobLocation.address.addressLocality || e.jobLocation.address.addressRegion)) || null,
                                salary: e.baseSalary ? (e.baseSalary.value?.value || e.baseSalary.minValue || e.baseSalary.maxValue || null) : null,
                                job_type: e.employmentType || null,
                            };
                        }
                    }
                } catch (e) { /* ignore parsing errors */ }
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
            const showMore = $('button').filter((_, el) => /show\s+more/i.test($(el).text())).first();
            if (showMore.length) {
                // Xing loads more via JS, need to construct next page URL
                const currentUrl = new URL(base);
                const currentPage = parseInt(currentUrl.searchParams.get('page') || '1');
                currentUrl.searchParams.set('page', String(currentPage + 1));
                return currentUrl.href;
            }
            return null;
        }

        const crawler = new CheerioCrawler({
            proxyConfiguration: proxyConf,
            maxRequestRetries: 3,
            useSessionPool: true,
            maxConcurrency: 10,
            requestHandlerTimeoutSecs: 60,
            async requestHandler({ request, $, enqueueLinks, log: crawlerLog }) {
                const label = request.userData?.label || 'LIST';
                const pageNo = request.userData?.pageNo || 1;

                if (label === 'LIST') {
                    const links = findJobLinks($, request.url);
                    crawlerLog.info(`LIST ${request.url} -> found ${links.length} links`);

                    if (collectDetails) {
                        const remaining = RESULTS_WANTED - saved;
                        const toEnqueue = links.slice(0, Math.max(0, remaining));
                        if (toEnqueue.length) await enqueueLinks({ urls: toEnqueue, userData: { label: 'DETAIL' } });
                    } else {
                        const remaining = RESULTS_WANTED - saved;
                        const toPush = links.slice(0, Math.max(0, remaining));
                        if (toPush.length) { await Dataset.pushData(toPush.map(u => ({ url: u, _source: 'xing.com' }))); saved += toPush.length; }
                    }

                    if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                        const next = findNextPage($, request.url);
                        if (next) await enqueueLinks({ urls: [next], userData: { label: 'LIST', pageNo: pageNo + 1 } });
                    }
                    return;
                }

                if (label === 'DETAIL') {
                    if (saved >= RESULTS_WANTED) return;
                    try {
                        const json = extractFromJsonLd($);
                        const data = json || {};
                        if (!data.title) data.title = $('h1, [data-testid="job-title"], .job-title').first().text().trim() || null;
                        if (!data.company) {
                            const companyEl = $('[data-testid="company-name"], .company-name, [class*="company"]').first();
                            data.company = companyEl.text().trim() || null;
                        }
                        if (!data.description_html) { 
                            const desc = $('[data-testid="job-description"], [class*="job-description"], .description, article').first(); 
                            data.description_html = desc && desc.length ? String(desc.html()).trim() : null; 
                        }
                        data.description_text = data.description_html ? cleanText(data.description_html) : null;
                        if (!data.location) {
                            const locEl = $('[data-testid="job-location"], [class*="location"], .location').first();
                            data.location = locEl.text().trim() || null;
                        }
                        if (!data.salary) {
                            const salaryEl = $('[data-testid="salary"], [class*="salary"]').first();
                            data.salary = salaryEl.text().trim() || null;
                        }
                        if (!data.job_type) {
                            const typeEl = $('[data-testid="employment-type"], [class*="employment-type"]').first();
                            data.job_type = typeEl.text().trim() || null;
                        }

                        const item = {
                            title: data.title || null,
                            company: data.company || null,
                            discipline: discipline || null,
                            location: data.location || null,
                            salary: data.salary || null,
                            job_type: data.job_type || null,
                            date_posted: data.date_posted || null,
                            description_html: data.description_html || null,
                            description_text: data.description_text || null,
                            url: request.url,
                        };

                        await Dataset.pushData(item);
                        saved++;
                    } catch (err) { crawlerLog.error(`DETAIL ${request.url} failed: ${err.message}`); }
                }
            }
        });

        await crawler.run(initial.map(u => ({ url: u, userData: { label: 'LIST', pageNo: 1 } })));
        log.info(`Finished. Saved ${saved} items`);
    } finally {
        await Actor.exit();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
