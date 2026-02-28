const axios = require('axios');
const cheerio = require('cheerio');

// List domain cadangan untuk auto-fallback source
const SOURCE_DOMAINS = [
    'https://anichin.moe',
    'https://anichin.care',
    'https://anichin.cam',
    'https://anichin.vip',
    'https://anichin.top',
    'https://anichin.id'
];

const DONGHUB_URL = 'https://donghub.vip';

let ACTIVE_SOURCE_URL = SOURCE_DOMAINS[0];

const getHeaders = (url) => ({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Referer': url || ACTIVE_SOURCE_URL || 'https://www.google.com/',
    'Cache-Control': 'max-age=0',
    'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1'
});

// In-memory cache for mapping Poster URL to Anime Slug
let ANIME_SLUG_MAP = new Map();

// Helper to normalize slug by removing episode parts
const extractBaseSlug = (slug) => {
    if (!slug) return '';
    // Regex lebih agresif untuk hapus episode, subtitle, dan angka di akhir
    let base = slug.replace(/-(episode|ep|s\d+-episode)-\d+.*/i, '')
        .replace(/-(subtitle-indonesia|sub-indo|subtitle-indo).*/i, '')
        .replace(/\/$/, '');

    // Khusus Movie: Jika ada suffix '-movie' diikuti subtitle, bersihkan juga
    if (base.includes('-movie-') && base.endsWith('-indonesia')) {
        base = base.replace(/-subtitle-indonesia.*/i, '').replace(/-indonesia.*/i, '');
    }

    return base;
};

// Tracking koneksi terakhir yang sukses untuk optimasi speed
let LAST_CONNECTION_STATUS = {
    method: 'direct', // 'direct' atau 'proxy'
    lastChecked: 0,
    failCount: 0
};

const scraper = {
    get ACTIVE_SOURCE_URL() { return ACTIVE_SOURCE_URL; },
    get LAST_CONNECTION_STATUS() { return LAST_CONNECTION_STATUS; },
    // Fungsi pintar untuk mencari domain source yang sedang
    _checkActiveSource: async () => {
        console.log('🔍 Checking for active source domain...');
        for (const domain of SOURCE_DOMAINS) {
            try {
                console.log(`🔗 Testing ${domain}...`);
                const res = await axios.get(domain, {
                    headers: getHeaders(domain),
                    timeout: 5000, // Reduced from 10s for faster check
                    maxRedirects: 5
                });
                // Verifikasi: Harus 200 OK EAN isinya harus ada tanda-tanda item anime (bs/utao/animatpost)
                if (res.status === 200 && (res.data.includes('bs') || res.data.includes('utao') || res.data.includes('animatpost')) && !res.data.includes('challenge-running')) {
                    ACTIVE_SOURCE_URL = domain;
                    console.log(`✅ Active Source Found: ${ACTIVE_SOURCE_URL}`);

                    // Reset connection status on success
                    LAST_CONNECTION_STATUS.method = 'direct';
                    LAST_CONNECTION_STATUS.lastChecked = Date.now();
                    LAST_CONNECTION_STATUS.failCount = 0;

                    // Pre-seed slug map from Ongoing
                    setTimeout(() => scraper._preSeedSlugMap(), 1000);

                    return domain;
                }
            } catch (err) {
                console.log(`❌ Domain ${domain} error: ${err.message}`);
            }
        }
        console.log(`⚠️ No fresh domain found, keeping: ${ACTIVE_SOURCE_URL}`);
        return ACTIVE_SOURCE_URL;
    },

    _preSeedSlugMap: async () => {
        try {
            console.log('🌱 Pre-seeding Slug Map from Ongoing...');
            // Fetch ongoing to index slugs
            await scraper.getOngoing(1);
            await scraper.getOngoing(2);
        } catch (e) {
            console.error('Failed to pre-seed slug map:', e.message);
        }
    },

    // Helper request khusus source
    _sourceGet: async (path) => {
        const targetUrl = path.startsWith('http') ? path : `${ACTIVE_SOURCE_URL}${path}`;

        // Cache busting: tambahkan timestamp unik setiap 1 menit agar proxy tidak kasih data lama
        const timestamp = Math.floor(Date.now() / 60000);
        const separator = targetUrl.includes('?') ? '&' : '?';
        const freshUrl = `${targetUrl}${separator}_cb=${timestamp}`;

        const isRecentlyFailed = LAST_CONNECTION_STATUS.method === 'proxy' && (Date.now() - LAST_CONNECTION_STATUS.lastChecked < 30 * 60 * 1000);

        // 1. Coba Direct Connection (Hanya jika belum pernah gagal baru-baru ini)
        if (!isRecentlyFailed || LAST_CONNECTION_STATUS.failCount < 3) {
            try {
                const timeout = isRecentlyFailed ? 2000 : 8000; // Jika pernah gagal, sikat cepet aja 2 detik
                console.log(`[GET DIRECT] ${targetUrl} (Timeout: ${timeout}ms)`);
                const response = await axios.get(targetUrl, {
                    headers: getHeaders(targetUrl),
                    timeout: timeout
                });

                if (response.status === 200 && (response.data.includes('bs') || response.data.includes('utao') || response.data.includes('animatpost')) && !response.data.includes('challenge-running')) {
                    LAST_CONNECTION_STATUS.method = 'direct';
                    LAST_CONNECTION_STATUS.lastChecked = Date.now();
                    return response;
                }
                console.log(`[DIRECT FAIL] suspicious content or blocked`);
            } catch (error) {
                console.log(`[DIRECT ERROR] ${targetUrl}: Switching to proxy logic...`);
                LAST_CONNECTION_STATUS.failCount++;
                if (LAST_CONNECTION_STATUS.failCount >= 2) {
                    LAST_CONNECTION_STATUS.method = 'proxy';
                    LAST_CONNECTION_STATUS.lastChecked = Date.now();
                }
            }
        } else {
            console.log(`[SKIP DIRECT] Fast-tracking to Proxy for: ${targetUrl}`);
        }

        // 2. Coba via CORS Proxy (Priority 2) - CORSProxy.io dengan Cache Busting
        try {
            const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(freshUrl)}`;
            console.log(`[PROXY 1] Fetching...`);
            const response = await axios.get(proxyUrl, {
                headers: { 'User-Agent': getHeaders()['User-Agent'] },
                timeout: 15000
            });
            if (response.status === 200 && response.data && response.data.includes('html')) {
                LAST_CONNECTION_STATUS.lastChecked = Date.now();
                return response;
            }
        } catch (error) {
            console.error(`[PROXY 1 ERROR]: ${error.message}`);
        }

        // 3. Coba via AllOrigins (Priority 3)
        try {
            const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(freshUrl)}`;
            console.log(`[PROXY 2] Trying AllOrigins...`);
            const response = await axios.get(proxyUrl, { timeout: 15000 });
            if (response.status === 200 && response.data && response.data.includes('html')) {
                LAST_CONNECTION_STATUS.lastChecked = Date.now();
                return response;
            }
        } catch (error) {
            console.error(`[PROXY 2 ERROR]: ${error.message}`);
        }

        // 4. New Fallback Proxy (Priority 4) - Cloudflare Worker or similar generic
        try {
            const proxyUrl = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl)}`;
            console.log(`[PROXY 3] Trying CodeTabs...`);
            const response = await axios.get(proxyUrl, { timeout: 15000 });
            if (response.status === 200 && response.data && response.data.includes('html')) {
                LAST_CONNECTION_STATUS.lastChecked = Date.now();
                return response;
            }
        } catch (error) {
            console.error(`[PROXY 3 ERROR]: ${error.message}`);
        }

        // 5. Coba via Weserv
        try {
            const proxyUrl = `https://images.weserv.nl/?url=${encodeURIComponent(targetUrl.replace('https://', ''))}&nocache=${timestamp}`;
            console.log(`[PROXY 4] Final fallback (Weserv)...`);
            const response = await axios.get(proxyUrl, { timeout: 15000 });
            if (response.status === 200 && response.data) {
                LAST_CONNECTION_STATUS.lastChecked = Date.now();
                return response;
            }
        } catch (error) {
            console.error(`[PROXY 4 ERROR]: ${error.message}`);
        }

        throw new Error(`Semua jalur koneksi (Direct & Proxy) gagal. Source kemungkinan down.`);
    },

    // Scraper untuk source List
    _scrapeSourceList: async (path, baseSelector = '.listupd .utao, .listupd .bs, .bs, .utao, .animatpost') => {
        try {
            const response = await scraper._sourceGet(path);
            const $ = cheerio.load(response.data);
            const list = [];

            $(baseSelector).each((i, el) => {
                // If path suggests it's an anime list (ongoing/completed/search), flag it
                const isAnime = path.includes('status=') || path.includes('/genres/') || path.includes('/anime/') || path.includes('s=');
                const item = scraper._extractItemData($, el, isAnime);
                if (item) list.push(item);
            });

            // Deduplicate
            return list.filter((v, i, a) => a.findIndex(t => (t.slug === v.slug)) === i);
        } catch (error) {
            console.error(`[_scrapeSourceList ERROR] ${path}:`, error.message);
            // RE-THROW error so getHome can catch it as a failure, NOT success with empty list
            throw error;
        }
    },

    // Slug mappings for problematic links
    _SLUG_MAPPINGS: {
        'btth-season-5': 'oyen-pertempuran-akhir-sekte-misty-cloud',
        'btth-s5': 'oyen-pertempuran-akhir-sekte-misty-cloud',
        'btth-s5-episode': 'oyen-pertempuran-akhir-sekte-misty-cloud',
        'btth-season-5-episode': 'oyen-pertempuran-akhir-sekte-misty-cloud',
        'oyen-season-5': 'oyen-pertempuran-akhir-sekte-misty-cloud',
        'oyen-season-5-episode': 'oyen-pertempuran-akhir-sekte-misty-cloud',
        'battle-through-the-heavens-season-5': 'oyen-pertempuran-akhir-sekte-misty-cloud',
        'tales-of-herding-gods': 'tales-of-herding-god',
        'tales-of-herding-gods-subtitle-indonesia': 'tales-of-herding-god',
        'tales-of-herding-god-subtitle-indonesia': 'tales-of-herding-god'
    },

    // Helper fungasi extraksi data item tunggal
    _extractItemData: ($, el, isAnime = false) => {
        const linkElement = $(el).find('a').first();
        const link = linkElement.attr('href');
        if (!link) return null;

        const title = linkElement.attr('title') || $(el).find('.tt h2').text().trim() || $(el).find('.tt').text().trim();
        if (!title || title.toLowerCase() === 'home' || title.toLowerCase() === 'anime') return null;

        let slug = link.replace(ACTIVE_SOURCE_URL, '').replace(/\/$/, '').split('/').pop();

        // Apply mapping if exists
        if (scraper._SLUG_MAPPINGS[slug]) {
            slug = scraper._SLUG_MAPPINGS[slug];
        }

        // Ambil gambar dengan prioritas data-src (lazy load)
        const poster = $(el).find('img').attr('data-src') || $(el).find('img').attr('src') || $(el).find('img').attr('data-lazy-src');

        // IF this is known to be an anime (from ongoing/completed list), index it!
        if (isAnime && poster && slug) {
            // Clean poster URL for better indexing (remove resize params if any)
            const cleanPoster = poster.split('?')[0];
            const baseSlug = extractBaseSlug(slug); // Selalu bersihkan jadi base slug sebelum di-index

            // Map the base slug if it's a known problematic one (like BTTH)
            const mappedBase = scraper._SLUG_MAPPINGS[baseSlug] || baseSlug;

            if (!ANIME_SLUG_MAP.has(cleanPoster) && mappedBase) {
                ANIME_SLUG_MAP.set(cleanPoster, mappedBase);
            }
        }

        // Try to find the correct anime slug from the map using the poster
        let anime_slug = null;
        if (poster) {
            anime_slug = ANIME_SLUG_MAP.get(poster.split('?')[0]);
        }

        // If not found in map, attempt a smart extraction as fallback
        if (!anime_slug) {
            anime_slug = extractBaseSlug(slug);
        }

        // Final mapping check for anime_slug (important for episodes!)
        if (scraper._SLUG_MAPPINGS[anime_slug]) {
            anime_slug = scraper._SLUG_MAPPINGS[anime_slug];
        }

        // BULLETPROOF: Ensure anime_slug is ALWAYS a base slug (no "episode" etc)
        // unless it's explicitly a movie or something that doesn't follow episode patterns
        if (anime_slug) {
            anime_slug = extractBaseSlug(anime_slug);
            // Re-check mapping after cleaning again
            if (scraper._SLUG_MAPPINGS[anime_slug]) {
                anime_slug = scraper._SLUG_MAPPINGS[anime_slug];
            }
        }

        // Jika ini adalah list anime (bukan episode), pastikan anime_slug = slug versi bersih
        if (isAnime) {
            anime_slug = extractBaseSlug(slug);
        }

        // Ambil Episode: Bersihkan teks "Episode " jadi "Ep "
        let ep = $(el).find('.epx, .epxs, .ep').first().text().trim();
        ep = ep.replace(/^Episode\s+/i, 'Ep ').replace(/^Ep\s+/i, 'Ep ');

        // Jika kosong, coba ambil dari judul jika ada pola "Episode X"
        if (!ep || ep === '') {
            const match = title.match(/Episode\s+(\d+)/i);
            if (match) ep = `Ep ${match[1]}`;
        }

        // Ambil Type/Status
        let type = $(el).find('.typez').first().text().trim();
        // Jika type kosong, default ke Donghua
        if (!type) type = 'Donghua';

        const score = $(el).find('.numscore').text().trim();

        // Dummy Views & Rating for "Premium" feel
        const viewsCount = Math.floor(Math.random() * (2500000 - 50000) + 50000);
        const autoRating = (Math.random() * (9.9 - 8.8) + 8.8).toFixed(1);

        return {
            title: title.split(' Subtitle')[0].split(' Sub ')[0].trim(),
            slug,
            anime_slug,
            poster,
            ep: ep || "Ep New",
            type: type, // Frontend akan handle warna label berdasarkan text ini
            score: score && score !== '' ? score : autoRating,
            views: viewsCount,
            source: 'DonghuaWatch'
        };
    },


    // Merge logic pintar: Cari episode tertinggi jika ada duplikat
    _mergeLists: (list1, list2) => {
        const map = new Map();

        // Gabungkan kedua list
        const combined = [...list1, ...list2];

        combined.forEach(item => {
            const seriesId = scraper._normalizeTitle(item.title);
            const currentEpNum = scraper._extractEpNumber(item.ep);

            if (!map.has(seriesId)) {
                map.set(seriesId, item);
            } else {
                const existingItem = map.get(seriesId);
                const existingEpNum = scraper._extractEpNumber(existingItem.ep);

                // Jika item baru punya episode lebih tinggi, ganti yang lama
                if (currentEpNum > existingEpNum) {
                    map.set(seriesId, item);
                }
            }
        });

        return Array.from(map.values());
    },

    _normalizeTitle: (title) => {
        return title.toLowerCase()
            .replace(/season\s*\d+/g, '')
            .replace(/episode\s*\d+/g, '')
            .replace(/subtitle\s*indonesia/g, '')
            .replace(/[^a-z0-9]/g, '');
    },

    _extractEpNumber: (epString) => {
        if (!epString) return 0;
        const match = epString.match(/\d+/); // Ambil angka pertama yang ketemu
        return match ? parseInt(match[0]) : 0;
    },

    getHome: async (page = 1) => {
        const path = page > 1 ? `/page/${page}/` : '/';

        try {
            const response = await scraper._sourceGet(path);
            const $ = cheerio.load(response.data);

            // 1. Ambil dari section Latest Release
            const latestList = [];
            // Try specific selector first
            $('.latesthome').closest('.bixbox').find('.listupd article.bs, article.bs').each((i, el) => {
                const item = scraper._extractItemData($, el, false);
                if (item) latestList.push(item);
            });

            // Fallback for Latest Release - find any .bs if the specific one failed
            if (latestList.length === 0) {
                $('.listupd.normal article.bs, .listupd article.bs, article.bs').each((i, el) => {
                    const item = scraper._extractItemData($, el, false);
                    if (item) latestList.push(item);
                });
            }

            // 2. Ambil dari section Popular Today (hanya di page 1)
            const popularList = [];
            if (page === 1 || path === '/') {
                const popularContainer = $('.hothome').closest('.bixbox');
                popularContainer.find('.listupd article.bs, article.bs').each((i, el) => {
                    const item = scraper._extractItemData($, el, true);
                    if (item) popularList.push(item);
                });

                // Jika masih kosong, coba selector alternatif untuk popular
                if (popularList.length === 0) {
                    $('.hothome article.bs, #header article.bs, .popular article.bs').each((i, el) => {
                        const item = scraper._extractItemData($, el, true);
                        if (item) popularList.push(item);
                    });
                }
            }

            console.log(`[Scraper] getHome page ${page}: Found ${latestList.length} latest, ${popularList.length} popular items.`);

            // CRITICAL: If EVERYTHING is empty, it's likely a scraping failure (Cloudflare, etc)
            if (latestList.length === 0 && popularList.length === 0) {
                console.log(`[Scraper] ERROR: Home content empty! Source HTML length: ${response.data.length}`);
                throw new Error("Gagal mengambil data: Konten kosong (kemungkinan proteksi Cloudflare)");
            }

            return scraper._applyFilter({
                status: 'success',
                data: latestList,
                popular: popularList.length > 0 ? popularList : null
            });
        } catch (error) {
            console.error("[getHome ERROR]:", error.message);
            // RE-THROW to trigger cache recovery or 500
            throw error;
        }
    },

    getLatest: async (page = 1) => {
        return scraper.getHome(page);
    },

    getOngoing: async (page = 1) => {
        const path = `/anime/?page=${page}&status=ongoing&order=update`;
        let list = await scraper._scrapeSourceList(path);
        return scraper._applyFilter({ status: 'success', page, data: list });
    },

    getCompleted: async (page = 1) => {
        const path = `/anime/?page=${page}&status=completed&order=update`;
        let list = await scraper._scrapeSourceList(path);
        return scraper._applyFilter({ status: 'success', page, data: list });
    },

    getGenres: async () => {
        try {
            const response = await scraper._sourceGet('/genres/');
            const $ = cheerio.load(response.data);
            const genres = [];
            $('.taxindex li a').each((i, el) => {
                const name = $(el).find('.name').text().trim() || $(el).text().trim().split(' (')[0];
                const href = $(el).attr('href') || '';
                const slug = href.replace(/\/$/, '').split('/').pop();
                if (name && slug) genres.push({ name, slug: slug.toLowerCase() });
            });
            return scraper._applyFilter({ status: 'success', data: genres });
        } catch (error) {
            return { status: 'error', message: error.message };
        }
    },
    //p
    getByGenre: async (slug, page = 1) => {
        const path = `/genres/${slug}/page/${page}/`;
        const list = await scraper._scrapeSourceList(path);
        return { status: 'success', genre: slug, page, data: list };
    },

    getByLetter: async (slug, page = 1) => {
        const path = `/anime/?page=${page}&list=${slug.toUpperCase()}`;
        const list = await scraper._scrapeSourceList(path);
        return { status: 'success', letter: slug, page, data: list };
    },

    getBySeason: async (year, page = 1) => {
        // Year can be "winter-2024" or just "2024"
        const path = `/anime/?page=${page}&season=${year}`;
        const list = await scraper._scrapeSourceList(path);
        return scraper._applyFilter({ status: 'success', season: year, page, data: list });
    },

    getSchedule: async () => {
        try {
            const response = await scraper._sourceGet('/schedule/');
            const $ = cheerio.load(response.data);
            const schedule = [];
            $('.bixbox.schedulepage').each((i, el) => {
                let dayRaw = $(el).find('h3 span, h2 span, h3, h2').first().text().trim().toLowerCase();
                // Extract only the day name (senin, selasa, etc. or Monday, Tuesday, etc.)
                const daysIndo = ['senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu', 'minggu'];
                const daysEng = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

                let day = daysIndo.find(d => dayRaw.includes(d)) || daysEng.find(d => dayRaw.includes(d)) || dayRaw;

                // Map English to Indo if needed by frontend
                const engToIndo = {
                    'monday': 'senin', 'tuesday': 'selasa', 'wednesday': 'rabu',
                    'thursday': 'kamis', 'friday': 'jumat', 'saturday': 'sabtu', 'sunday': 'minggu'
                };
                if (engToIndo[day]) day = engToIndo[day];

                const items = [];
                $(el).find('.listupd .bs, ul li').each((j, li) => {
                    const time = $(li).find('.time').text().trim();
                    const titleElement = $(li).find('.tt, a').not('.time').last();
                    let title = titleElement.text().replace(time, '').trim();

                    // Bersihkan "at XX:XX" atau "released" dari judul
                    title = title.replace(/at \d{2}:\d{2}/g, '').replace(/released/g, '').trim();
                    // Hapus angka di depan jika ada (misal "14The Gate..." -> "The Gate...")
                    title = title.replace(/^\d+/, '').trim();

                    const link = $(li).find('a').attr('href');
                    const slug = link ? link.replace(/\/$/, '').split('/').pop() : '';

                    // Coba ekstrak episode dari Judul atau Link
                    let episode = 'New';
                    // Cari pola angka di akhir slug atau judul
                    const epMatch = slug.match(/episode-(\d+)/) || title.match(/Episode\s+(\d+)/i) || title.match(/\s(\d+)$/);
                    if (epMatch) {
                        episode = `Ep ${epMatch[1]}`;
                    }

                    if (title && slug) items.push({ title, slug, episode });
                });
                if (day && items.length > 0) schedule.push({ day, items });
            });
            return scraper._applyFilter({ status: 'success', data: schedule });
        } catch (error) {
            console.error('[getSchedule ERROR]:', error.message);
            return { status: 'error', message: error.message };
        }
    },

    getDetail: async (slug) => {
        // Redirection for mapped slugs
        if (scraper._SLUG_MAPPINGS[slug]) {
            console.log(`[Scraper] Remapping slug: ${slug} -> ${scraper._SLUG_MAPPINGS[slug]}`);
            slug = scraper._SLUG_MAPPINGS[slug];
        }

        try {
            const response = await scraper._sourceGet(`/anime/${slug}`);
            const $ = cheerio.load(response.data);
            const title = $('.entry-title').text().trim();
            const poster = $('.thumb img').attr('data-src') || $('.thumb img').attr('src');
            let synopsis = $('.entry-content p, .sinopsis, .entry-content').first().text().trim();
            // Filter: Ganti penyebutan Anichin di sinopsis dengan DonghuaWatch
            if (synopsis) {
                synopsis = synopsis.replace(/anichin/gi, 'DonghuaWatch');
            }

            const info = {};
            $('.spe span').each((i, el) => {
                const text = $(el).text();
                if (text.includes(':')) {
                    const parts = text.split(':');
                    const key = parts[0].trim().toLowerCase().replace(/\s+/g, '_');
                    const value = parts[1].trim();
                    if (key && value) info[key] = value;
                }
            });

            const genres = [];
            $('.genx a').each((i, el) => {
                const name = $(el).text().trim();
                const link = $(el).attr('href');
                const slug = link ? link.replace(/\/$/, '').split('/').pop() : '';
                genres.push({ name, slug });
            });

            const episodes = [];
            $('.eplister li').each((i, el) => {
                const epNum = $(el).find('.epl-num').text().trim();
                const epTitle = $(el).find('.epl-title').text().trim();
                const fullTitle = epNum && epTitle ? `${epNum} ${epTitle}` : (epTitle || epNum);

                const link = $(el).find('a').attr('href');
                if (!link) return;

                let epSlug = link.replace(/\/$/, '').split('/').pop();

                const date = $(el).find('.epl-date').text().trim();
                episodes.push({
                    title: fullTitle.includes('Episode') ? fullTitle : `Episode ${fullTitle}`,
                    slug: epSlug,
                    date
                });
            });

            const rating = $('.numscore').first().text().trim() || info.rating || info.skor || '0.0';

            return scraper._applyFilter({
                status: 'success',
                data: {
                    title,
                    poster,
                    synopsis,
                    rating,
                    status: info.status || 'Ongoing',
                    type: info.type || 'ONA',
                    studio: info.studio || '-',
                    released: info.released || info.rilis || '-',
                    duration: info.duration || info.durasi || '-',
                    episodes_count: info.episodes || info.total_episode || '-',
                    genres,
                    episodes_list: episodes,
                    info // Keep original info object just in case
                }
            });
        } catch (error) { return { status: 'error', message: error.message }; }
    },

    getEpisode: async (slug) => {
        try {
            console.log(`[Scraper] Fetching Episode: ${slug}`);
            const response = await scraper._sourceGet(`/${slug}/`);
            const $ = cheerio.load(response.data);
            const title = $('.entry-title').text().trim();

            // Extract streaming servers
            const servers = [];
            $('.mirror option').each((i, el) => {
                const name = $(el).text().trim();
                const value = $(el).attr('value');
                if (value) {
                    let url = value;
                    // Decode base64
                    if (value.startsWith('ey') || /^[a-zA-Z0-9+/]+={0,2}$/.test(value)) {
                        try { url = Buffer.from(value, 'base64').toString(); } catch (e) { }
                    }
                    // Handle iframe tags or direct URLs
                    if (url.includes('iframe')) {
                        const match = url.match(/src="([^"]+)"/);
                        if (match) url = match[1];
                    }
                    if (url.startsWith('//')) url = 'https:' + url;
                    if (url && (url.startsWith('http') || url.includes('iframe'))) {
                        servers.push({ name: name || `Server ${i + 1}`, url });
                    }
                }
            });

            // If no servers found in dropdown, try other common player containers
            if (servers.length === 0) {
                const selectors = [
                    '.video-content iframe',
                    '#embed_holder iframe',
                    '.player-embed iframe',
                    '#video-container iframe',
                    '.entry-content iframe'
                ];
                for (const selector of selectors) {
                    const src = $(selector).first().attr('src');
                    if (src) {
                        servers.push({ name: 'Default', url: src.startsWith('//') ? 'https:' + src : src });
                        break;
                    }
                }
            }

            // Extract download links
            const download_url = {};

            // Format 1: .dl-link or .download-link
            $('.dl-link, .download-link').each((i, el) => {
                const qualityText = $(el).find('.quality, b').first().text().trim().toLowerCase();
                const quality = qualityText.includes('1080') ? 'mp4_1080p' :
                    qualityText.includes('720') ? 'mp4_720p' :
                        qualityText.includes('480') ? 'mp4_480p' : 'mp4_360p';

                const links = {};
                $(el).find('a').each((j, a) => {
                    links[$(a).text().trim()] = $(a).attr('href');
                });
                if (Object.keys(links).length > 0) download_url[quality] = links;
            });

            // Format 2: .soraurlx (New Format)
            if (Object.keys(download_url).length === 0) {
                $('.soraurlx').each((i, el) => {
                    const qualityText = $(el).find('strong').text().trim().toLowerCase();
                    const quality = qualityText.includes('1080') ? 'mp4_1080p' :
                        qualityText.includes('720') ? 'mp4_720p' :
                            qualityText.includes('480') ? 'mp4_480p' :
                                qualityText.includes('360') ? 'mp4_360p' :
                                    qualityText.includes('4k') ? 'mp4_4k' : `mp4_${qualityText.replace(/\s+/g, '_')}`;

                    const links = {};
                    $(el).find('a').each((j, a) => {
                        const linkText = $(a).text().trim() || 'Download';
                        links[linkText] = $(a).attr('href');
                    });
                    if (Object.keys(links).length > 0) download_url[quality] = links;
                });
            }

            // Navigation
            const navigation = {};
            $('.navep a').each((i, el) => {
                const text = $(el).text().toLowerCase();
                const link = $(el).attr('href');
                if (link) {
                    const epSlug = link.replace(/\/$/, '').split('/').pop();
                    if (text.includes('prev')) navigation.previous_episode = { slug: epSlug };
                    if (text.includes('next')) navigation.next_episode = { slug: epSlug };
                }
            });

            const poster = $('.thumb img').attr('data-src') || $('.thumb img').attr('src') || $('.wp-post-image').attr('src');

            // 1. Try to get series link from Breadcrumbs/Meta (Most reliable)
            const seriesLink = $('.nvs.jc a, .breadcrumb a, .genredesc a, .item a').filter((i, el) => {
                const h = $(el).attr('href') || '';
                const t = $(el).text().toLowerCase();
                return h && (h.includes('/anime/') || h.includes('/series/')) && !t.includes('home') && !t.includes('genre');
            }).first();

            const rawHref = seriesLink.attr('href') || '';
            let seriesSlug = rawHref.replace(/\/$/, '').split('/').pop();

            // 2. Fallback: Try Poster-to-Slug mapping (The "Smart" way)
            if ((!seriesSlug || seriesSlug === 'anime' || seriesSlug === 'series') && poster) {
                const cleanPoster = poster.split('?')[0];
                if (ANIME_SLUG_MAP.has(cleanPoster)) {
                    // console.log(`[Resolver] Used Poster Map to find series slug: ${ANIME_SLUG_MAP.get(cleanPoster)}`);
                    seriesSlug = ANIME_SLUG_MAP.get(cleanPoster);
                }
            }

            // 3. Fallback: Extract from episode slug
            if (!seriesSlug || seriesSlug === 'anime' || seriesSlug === 'series') {
                seriesSlug = extractBaseSlug(slug);
                // Manual cleanup for Oyen/BTTH cases
                if (seriesSlug.includes('btth') || seriesSlug.includes('oyen')) {
                    seriesSlug = 'oyen-pertempuran-akhir-sekte-misty-cloud';
                }
            }

            // Apply mapping for seriesSlug (Final Check)
            if (scraper._SLUG_MAPPINGS[seriesSlug]) {
                seriesSlug = scraper._SLUG_MAPPINGS[seriesSlug];
            }

            const seriesTitle = seriesLink.text().trim() || title.split(' Episode')[0];

            // To populate episodes_list and info, we scrape the series detail page
            let episodes_list = [];
            let synopsis = '-';
            try {
                if (seriesSlug) {
                    const detailRes = await scraper._sourceGet(`/anime/${seriesSlug}`);
                    const $d = cheerio.load(detailRes.data);

                    // Extract Synopsis
                    synopsis = $d('.entry-content p, .synopsis p').first().text().trim() || $d('.desc').text().trim();
                    if (synopsis) {
                        synopsis = synopsis.replace(/anichin/gi, 'DonghuaWatch');
                        // Filter out tutorial content
                        if (synopsis.toLowerCase().includes('tutorial') || synopsis.toLowerCase().includes('shortlink')) {
                            synopsis = "Ajak Qin Mu dan kawan-kawan berpetualang di dunia Donghua yang menakjubkan ini. Ikuti kisahnya setiap minggu hanya di DonghuaWatch.";
                        }
                    } else {
                        synopsis = "Donghua populer yang sedang tayang dengan kisah yang sangat menarik untuk diikuti. Tonton sekarang sub indo hanya di DonghuaWatch.";
                    }

                    $d('.eplister li').each((i, el) => {
                        const epNum = $d(el).find('.epl-num').text().trim();
                        const epName = $d(el).find('.epl-title').text().trim();
                        const fullTitle = epNum && epName ? `${epNum} ${epName}` : (epName || epNum);

                        const epLink = $d(el).find('a').attr('href');
                        if (epLink) {
                            episodes_list.push({
                                title: fullTitle.includes('Episode') ? fullTitle : `Episode ${fullTitle}`,
                                slug: epLink.replace(/\/$/, '').split('/').pop()
                            });
                        }
                    });
                }
            } catch (e) {
                console.error("Could not fetch extra details for episode page", e.message);
            }

            return scraper._applyFilter({
                status: 'success',
                data: {
                    title: title,
                    episode: title,
                    streaming: { servers, main_url: servers[0] },
                    download_url,
                    navigation,
                    donghua_details: {
                        title: seriesTitle,
                        slug: seriesSlug,
                        poster: poster,
                        synopsis: synopsis
                    },
                    episodes_list: episodes_list
                }
            });
        } catch (error) { return { status: 'error', message: error.message }; }
    },

    search: async (keyword, page = 1) => {
        const path = page > 1 ? `/page/${page}/?s=${encodeURIComponent(keyword)}` : `/?s=${encodeURIComponent(keyword)}`;
        const list = await scraper._scrapeSourceList(path);
        return scraper._applyFilter({ status: 'success', data: list });
    },

    // Helper fungasi untuk filter response global
    _applyFilter: (data) => {
        if (!data) return data;

        if (Array.isArray(data)) {
            return data.map(item => scraper._applyFilter(item));
        }

        if (typeof data === 'object' && data !== null) {
            const filtered = {};
            for (const key in data) {
                const value = data[key];
                if (typeof value === 'string') {
                    // Skip filtering for keys known to be critical URLs or slugs
                    const isCriticalUrl = ['poster', 'url', 'href', 'slug', 'main_url'].includes(key) ||
                        (value.startsWith('http') && (value.includes('/wp-content/') || value.includes('anichin.moe')));

                    if (isCriticalUrl) {
                        filtered[key] = value;
                    } else {
                        filtered[key] = value
                            .replace(/anichin\.(care|moe|cam|vip|top|id)/gi, 'DonghuaWatch.my.id')
                            .replace(/anichin/gi, 'DonghuaWatch');
                    }
                } else if (typeof value === 'object') {
                    filtered[key] = scraper._applyFilter(value);
                } else {
                    filtered[key] = value;
                }
            }
            return filtered;
        }
        return data;
    }
};

module.exports = scraper;
