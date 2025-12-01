// Xing Jobs Scraper - Production-Grade (Fast + Stealthy)
// Optimized for datacenter proxies with adaptive stealth features

import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset, sleep, RequestQueue, KeyValueStore } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

Actor.main(async () => {
    const input = (await Actor.getInput()) || {};
    const {
        keyword = '',
        location = '',
        discipline = '',
        results_wanted: RESULTS_WANTED_RAW = 20,
        max_pages: MAX_PAGES_RAW = 50,
        collectDetails = true,
        startUrl,
        startUrls,
        url,
        proxyConfiguration,
    } = input;

    log.info('🚀 Xing Jobs Scraper Starting', { 
        keyword, location, discipline, 
        results_wanted: RESULTS_WANTED_RAW, 
        max_pages: MAX_PAGES_RAW 
    });

    const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW)
        ? Math.max(1, +RESULTS_WANTED_RAW)
        : Number.MAX_SAFE_INTEGER;

    const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 50;
    const MAX_REQUESTS_PER_CRAWL = Math.min(RESULTS_WANTED * 4, 500);

    // Performance tracking
    const stats = {
        startTime: Date.now(),
        listPagesProcessed: 0,
        detailPagesProcessed: 0,
        itemsSaved: 0,
        errors: 0,
        blockedRequests: 0,
        averageRequestTime: [],
    };

    // Adaptive backoff management
    let globalBackoffMs = 0;
    let consecutiveSuccesses = 0;
    let saved = 0;

    // Detect proxy type for optimization
    const isDatacenterProxy = !proxyConfiguration?.apifyProxyGroups?.includes('RESIDENTIAL');
    
    log.info(`🔧 Proxy Mode: ${isDatacenterProxy ? 'DATACENTER (Speed Optimized)' : 'RESIDENTIAL (Stealth Optimized)'}`);

    // ====================
    // UTILITY FUNCTIONS
    // ====================

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

    // Enhanced salary parser
    const parseSalaryText = (raw) => {
        if (!raw) return null;
        let text = String(raw).replace(/\s+/g, ' ').trim();
        
        const firstCurrencyIndex = text.search(/[€£$]/);
        if (firstCurrencyIndex > 0) {
            text = text.slice(firstCurrencyIndex).trim();
        }

        const matches = text.match(/[€£$]\s?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?/g);
        if (!matches || !matches.length) return text;

        const uniques = Array.from(new Set(matches));
        if (uniques.length === 1) return uniques[0];
        if (uniques.length === 2) return `${uniques[0]} – ${uniques[1]}`;
        
        return `${uniques[0]} (avg), range ${uniques[1]} – ${uniques[uniques.length - 1]}`;
    };

    const buildStartUrl = (kw, loc, disc) => {
        let path = '/jobs';
        if (kw) {
            path += `/t-${encodeURIComponent(
                String(kw).trim().toLowerCase().replace(/\s+/g, '-')
            )}`;
        }
        const u = new URL(path, 'https://www.xing.com');
        if (kw) u.searchParams.set('keywords', String(kw).trim());
        if (loc) u.searchParams.set('location', String(loc).trim());
        if (disc) u.searchParams.set('discipline', String(disc).trim());
        return u.href;
    };

    // Smart URL validation - filters out non-job URLs early
    const isValidJobUrl = (url) => {
        if (!url) return false;
        // Xing job URLs: /jobs/[location-or-homeoffice]-[title]-[numeric-id]
        return /\/jobs\/[a-z0-9-]+-\d{6,}/i.test(url);
    };

    // ====================
    // DATA EXTRACTION
    // ====================

    const extractFromJsonLd = ($) => {
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
                                (e.jobLocation?.address?.addressLocality ||
                                 e.jobLocation?.address?.addressRegion) || null,
                            salary: e.baseSalary?.value?.value ||
                                    e.baseSalary?.minValue ||
                                    e.baseSalary?.maxValue || null,
                            job_type: e.employmentType || null,
                            remote_type: e.jobLocationType || null,
                            job_category: null,
                        };
                    }
                }
            } catch {
                // Ignore JSON-LD parsing errors
            }
        }
        return null;
    };

    const findJobLinks = ($, base) => {
        const links = new Set();
        
        // More specific selector for performance
        $('a[href*="/jobs/"]').each((_, el) => {
            const href = $(el).attr('href');
            if (!href) return;
            
            const abs = toAbs(href, base);
            if (abs && isValidJobUrl(abs)) {
                links.add(abs);
            }
        });

        return [...links];
    };

    const findNextPage = ($, base) => {
        // Check for "Show more" button
        const showMore = $('button').filter((_, el) => 
            /show\s+more/i.test($(el).text())
        ).first();
        
        if (showMore.length) {
            const currentUrl = new URL(base);
            const currentPage = parseInt(currentUrl.searchParams.get('page') || '1', 10);
            currentUrl.searchParams.set('page', String(currentPage + 1));
            return currentUrl.href;
        }

        // Check for pagination links
        const nextLink = $('a[aria-label*="Next" i], a[rel="next"]').first();
        if (nextLink.length) {
            return toAbs(nextLink.attr('href'), base);
        }

        return null;
    };

    // ====================
    // STEALTH FEATURES
    // ====================

    const USER_AGENTS = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    ];

    const ACCEPT_LANGUAGES = [
        'en-US,en;q=0.9',
        'en-GB,en;q=0.9',
        'de-DE,de;q=0.9,en;q=0.8',
        'en-US,en;q=0.9,de;q=0.8',
    ];

    const pickRandomUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    const pickRandomAcceptLang = () => ACCEPT_LANGUAGES[Math.floor(Math.random() * ACCEPT_LANGUAGES.length)];

    // ====================
    // SETUP
    // ====================

    const initial = [];
    if (Array.isArray(startUrls) && startUrls.length) initial.push(...startUrls);
    if (startUrl) initial.push(startUrl);
    if (url) initial.push(url);
    if (!initial.length) initial.push(buildStartUrl(keyword, location, discipline));

    const proxyConf = proxyConfiguration
        ? await Actor.createProxyConfiguration({ ...proxyConfiguration })
        : undefined;

    const requestQueue = await RequestQueue.open();
    const kvStore = await KeyValueStore.open();

    // Load previous state if exists (for resume capability)
    const previousState = await kvStore.getValue('STATE');
    if (previousState) {
        saved = previousState.saved || 0;
        stats.itemsSaved = saved;
        log.info(`📦 Resuming from previous state: ${saved} items already saved`);
    }

    // Enqueue initial URLs
    for (const u of initial) {
        await requestQueue.addRequest({ 
            url: u, 
            userData: { label: 'LIST', pageNo: 1 } 
        });
    }

    // ====================
    // CRAWLER CONFIGURATION
    // ====================

    const crawler = new CheerioCrawler({
        requestQueue,
        proxyConfiguration: proxyConf,
        
        // Optimized for datacenter proxies
        maxRequestRetries: isDatacenterProxy ? 2 : 3,
        maxRequestsPerCrawl: MAX_REQUESTS_PER_CRAWL,
        requestHandlerTimeoutSecs: isDatacenterProxy ? 20 : 30,
        
        // Session management
        useSessionPool: true,
        sessionPoolOptions: {
            maxPoolSize: isDatacenterProxy ? 50 : 100,
            sessionOptions: {
                maxUsageCount: isDatacenterProxy ? 30 : 50,
            },
        },

        // Concurrency: Balanced for speed and stealth across all proxy types
        minConcurrency: 8,
        maxConcurrency: 12,
        autoscaledPoolOptions: {
            desiredConcurrency: 10,
            scaleUpStepRatio: 0.1,
            scaleDownStepRatio: 0.05,
        },

        // ====================
        // PRE-NAVIGATION HOOKS
        // ====================
        preNavigationHooks: [
            async ({ request, session }, gotOptions) => {
                const requestStartTime = Date.now();
                request.userData.requestStartTime = requestStartTime;

                // Session-based UA persistence
                const ua = session?.userData?.ua || pickRandomUserAgent();
                if (session && !session.userData.ua) {
                    session.userData.ua = ua;
                }

                const acceptLang = session?.userData?.acceptLang || pickRandomAcceptLang();
                if (session && !session.userData.acceptLang) {
                    session.userData.acceptLang = acceptLang;
                }

                // Enhanced headers for stealth
                gotOptions.headers = {
                    ...(gotOptions.headers || {}),
                    'User-Agent': ua,
                    'Accept-Language': acceptLang,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'DNT': '1',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'none',
                    'Sec-Fetch-User': '?1',
                    'Cache-Control': 'max-age=0',
                };

                // Add referer for detail pages
                if (request.userData?.label === 'DETAIL') {
                    gotOptions.headers['Referer'] = 'https://www.xing.com/jobs';
                }

                // Adaptive delay based on mode and backoff
                let delayMs = isDatacenterProxy ? (30 + Math.random() * 70) : (80 + Math.random() * 140);
                
                // Apply global backoff if needed
                if (globalBackoffMs > 0) {
                    await sleep(globalBackoffMs);
                    globalBackoffMs = Math.max(0, globalBackoffMs - 50);
                }

                await sleep(delayMs);
            },
        ],

        // ====================
        // POST-NAVIGATION HOOKS
        // ====================
        postNavigationHooks: [
            async ({ request, response, session, log: hookLog }) => {
                if (!response) return;

                // Track request time
                if (request.userData.requestStartTime) {
                    const requestTime = Date.now() - request.userData.requestStartTime;
                    stats.averageRequestTime.push(requestTime);
                    if (stats.averageRequestTime.length > 100) {
                        stats.averageRequestTime.shift();
                    }
                }

                const status = response.statusCode;

                // Handle blocking/rate limiting
                if ([403, 429, 503].includes(status)) {
                    stats.blockedRequests++;
                    consecutiveSuccesses = 0;
                    
                    // Exponential backoff
                    const backoffIncrease = Math.min(1000 + (stats.blockedRequests * 200), 3000);
                    globalBackoffMs = Math.min(globalBackoffMs + backoffIncrease, 5000);
                    
                    hookLog.warning(
                        `⚠️ Status ${status} detected. Backoff: ${globalBackoffMs}ms, Blocked count: ${stats.blockedRequests}`
                    );

                    if (session) {
                        session.retire();
                    }

                    await sleep(500 + Math.random() * 500);
                }
                // Success - reduce backoff
                else if (status === 200) {
                    consecutiveSuccesses++;
                    if (consecutiveSuccesses > 10) {
                        globalBackoffMs = Math.max(0, globalBackoffMs - 100);
                        consecutiveSuccesses = 0;
                    }
                }
            },
        ],

        // ====================
        // FAILED REQUEST HANDLER
        // ====================
        failedRequestHandler: async ({ request, error }) => {
            stats.errors++;
            log.error(`❌ Request failed: ${request.url}`, { error: error?.message });
        },

        // ====================
        // REQUEST HANDLER
        // ====================
        async requestHandler({ request, $, enqueueLinks, log: crawlerLog }) {
            const label = request.userData?.label || 'LIST';
            const pageNo = request.userData?.pageNo || 1;

            // Early exit if quota reached
            if (saved >= RESULTS_WANTED) {
                crawlerLog.info(`✅ Quota reached (${saved}/${RESULTS_WANTED}), skipping ${request.url}`);
                return;
            }

            // ====================
            // LIST PAGE HANDLER
            // ====================
            if (label === 'LIST') {
                stats.listPagesProcessed++;
                
                const links = findJobLinks($, request.url);
                crawlerLog.info(
                    `📋 LIST page ${pageNo}: Found ${links.length} jobs | Saved: ${saved}/${RESULTS_WANTED} | URL: ${request.url}`
                );

                if (collectDetails) {
                    const remaining = RESULTS_WANTED - saved;
                    const toEnqueue = links.slice(0, Math.max(0, remaining));
                    
                    if (toEnqueue.length > 0) {
                        await enqueueLinks({
                            urls: toEnqueue,
                            userData: { label: 'DETAIL' },
                        });
                        crawlerLog.info(`➕ Enqueued ${toEnqueue.length} detail pages`);
                    }
                } else {
                    // Save URLs only without details
                    const remaining = RESULTS_WANTED - saved;
                    const toPush = links.slice(0, Math.max(0, remaining));
                    
                    if (toPush.length > 0) {
                        await Dataset.pushData(
                            toPush.map((u) => ({ 
                                url: u, 
                                _source: 'xing.com',
                                scraped_at: new Date().toISOString() 
                            }))
                        );
                        saved += toPush.length;
                        stats.itemsSaved = saved;
                        crawlerLog.info(`💾 Saved ${toPush.length} job URLs (total: ${saved})`);
                    }
                }

                // Pagination with smart stopping
                if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                    const next = findNextPage($, request.url);
                    if (next) {
                        await enqueueLinks({
                            urls: [next],
                            userData: { label: 'LIST', pageNo: pageNo + 1 },
                        });
                        crawlerLog.info(`➡️ Next page enqueued: Page ${pageNo + 1}`);
                    } else {
                        crawlerLog.info(`🏁 No more pages found. Stopping pagination.`);
                    }
                } else {
                    crawlerLog.info(`🛑 Stopping pagination: saved=${saved}, pageNo=${pageNo}`);
                }

                return;
            }

            // ====================
            // DETAIL PAGE HANDLER
            // ====================
            if (label === 'DETAIL') {
                if (saved >= RESULTS_WANTED) return;

                stats.detailPagesProcessed++;

                try {
                    const json = extractFromJsonLd($);
                    const data = json || {};

                    // Title extraction
                    if (!data.title) {
                        data.title = normalizeText(
                            $('h1, [data-testid="job-title"], .job-title, [class*="job-title"]').first().text()
                        );
                    }

                    // Company extraction
                    if (!data.company) {
                        const companyEl = $(
                            '[data-testid="company-name"], .company-name, [class*="company-name"], [class*="employer"]'
                        ).first();
                        data.company = normalizeText(companyEl.text());
                    }

                    // Description
                    if (!data.description_html) {
                        const desc = $(
                            '[data-testid="job-description"], [class*="job-description"], .description, article, [class*="job-content"]'
                        ).first();
                        data.description_html = desc && desc.length ? String(desc.html()).trim() : null;
                    }
                    data.description_text = data.description_html ? cleanText(data.description_html) : null;

                    // Location
                    if (!data.location) {
                        const locEl = $(
                            '[data-testid="job-location"], [class*="location"], .location'
                        ).first();
                        data.location = normalizeText(locEl.text());
                    }

                    // Salary extraction with multiple selectors
                    if (!data.salary) {
                        let rawSalaryText = '';
                        
                        // Try generic selectors first
                        const salaryGeneric = $('[data-testid="salary"], [class*="salary"]').first();
                        rawSalaryText = salaryGeneric.text() || '';

                        // Try specific Xing selectors
                        if (!rawSalaryText) {
                            const salarySelector = 'span.body-copy-styles__BodyCopy-sc-b3916c1b-0.dLgVbf.marker-styles__Text-sc-f046032b-2.bGmnFj';
                            rawSalaryText = $(salarySelector).eq(0).text() || '';
                        }

                        data.salary = parseSalaryText(rawSalaryText) || normalizeText(rawSalaryText) || null;
                    }

                    // Job type
                    if (!data.job_type) {
                        const typeEl = $('[data-testid="employment-type"], [class*="employment-type"]').first();
                        let typeText = normalizeText(typeEl.text());

                        if (!typeText) {
                            const jobTypeSelector = 'span.aria-extended-text__Text-sc-a2c0913c-0.gmPLC';
                            typeText = normalizeText($(jobTypeSelector).first().text());
                        }

                        data.job_type = typeText || null;
                    }

                    // Remote type
                    if (!data.remote_type) {
                        const remoteSelector = 'span.body-copy-styles__BodyCopy-sc-b3916c1b-0.dLgVbf.marker-styles__Text-sc-f046032b-2.bGmnFj';
                        const elems = $(remoteSelector);
                        
                        if (elems.length > 1) {
                            data.remote_type = normalizeText(elems.last().text());
                        }
                    }

                    // Job category
                    if (!data.job_category) {
                        const jobCategorySelector = 'p.body-copy-styles__BodyCopy-sc-b3916c1b-0.gIutZc.job-intro__AdditionalInfo-sc-5658992b-1.hDMxHz';
                        data.job_category = normalizeText($(jobCategorySelector).first().text());
                    }

                    const item = {
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
                        scraped_at: new Date().toISOString(),
                    };

                    await Dataset.pushData(item);
                    saved++;
                    stats.itemsSaved = saved;

                    crawlerLog.info(
                        `✅ Saved job [${saved}/${RESULTS_WANTED}]: ${item.title} at ${item.company}`
                    );

                    // Log missing fields for debugging
                    const missingFields = [];
                    if (!item.salary) missingFields.push('salary');
                    if (!item.job_type) missingFields.push('job_type');
                    if (!item.remote) missingFields.push('remote');
                    if (!item.job_category) missingFields.push('job_category');
                    
                    if (missingFields.length > 0) {
                        crawlerLog.debug(`⚠️ Missing fields: ${missingFields.join(', ')} | ${request.url}`);
                    }

                } catch (err) {
                    stats.errors++;
                    crawlerLog.error(`❌ DETAIL extraction failed: ${request.url}`, { error: err.message });
                }
            }
        },
    });

    // ====================
    // RUN CRAWLER
    // ====================

    log.info('🏃 Starting crawler...');
    await crawler.run();

    // ====================
    // FINAL STATISTICS
    // ====================

    const duration = (Date.now() - stats.startTime) / 1000;
    const avgRequestTime = stats.averageRequestTime.length > 0
        ? (stats.averageRequestTime.reduce((a, b) => a + b, 0) / stats.averageRequestTime.length).toFixed(0)
        : 0;
    const itemsPerMinute = duration > 0 ? ((stats.itemsSaved / duration) * 60).toFixed(2) : 0;

    log.info('📊 FINAL STATISTICS', {
        duration: `${duration.toFixed(1)}s`,
        itemsSaved: stats.itemsSaved,
        listPages: stats.listPagesProcessed,
        detailPages: stats.detailPagesProcessed,
        errors: stats.errors,
        blockedRequests: stats.blockedRequests,
        avgRequestTime: `${avgRequestTime}ms`,
        itemsPerMinute: itemsPerMinute,
        efficiency: `${((stats.itemsSaved / (stats.detailPagesProcessed || 1)) * 100).toFixed(1)}%`,
    });

    // Save final state
    await kvStore.setValue('STATE', {
        saved: stats.itemsSaved,
        completedAt: new Date().toISOString(),
        stats,
    });

    log.info(`✨ Scraping completed! Saved ${stats.itemsSaved} jobs in ${duration.toFixed(1)}s`);
});
