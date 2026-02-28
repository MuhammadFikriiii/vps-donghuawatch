const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const scraper = require('./scraper');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Fix for rate-limit when behind Nginx
app.set('trust proxy', 1);

// --- CORS Configuration ---
const allowedOrigins = [
    'https://donghuawatch.my.id',
    'https://donghuawatch.vercel.app',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:3000'
];

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, curl, etc)
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(null, true); // Allow all for now, rate limit handles abuse
        }
    }
}));

app.use(express.json());
app.use(express.static('public'));

// Rate Limiter Configuration
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 menit
    max: 100, // Limit unique IP to 100 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        status: 'error',
        message: 'Too many requests, please try again later.'
    },
    skip: (req, res) => {
        return allowedOrigins.includes(req.headers.origin);
    }
});

// Apply rate limiting to all API routes
app.use('/api/', apiLimiter);

// --- SMART CACHING LAYER ---
const apiCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 Minutes fresh
const STALE_TTL = 30 * 60 * 1000; // 30 Minutes stale (return old data while fetching)

/**
 * Smart cache wrapper that handles:
 * 1. Stale-While-Revalidate (SWR)
 * 2. Request Collapsing
 */
const getCachedData = async (key, fetcher, forceRefresh = false) => {
    const now = Date.now();
    const cached = apiCache.get(key);

    // 1. If valid fresh cache exists, return it
    if (!forceRefresh && cached && cached.data && (now - cached.timestamp < CACHE_TTL)) {
        return cached.data;
    }

    // 2. If a request for this key is ALREADY in progress, join that promise
    if (cached && cached.promise) {
        return cached.promise;
    }

    // 3. Stale-While-Revalidate: If data is stale but still within STALE_TTL
    if (!forceRefresh && cached && cached.data && (now - cached.timestamp < STALE_TTL)) {
        console.log(`[SWR] Serving stale data for: ${key}`);
        // Trigger background refresh
        fetcher().then(data => {
            // CRITICAL FIX: Only update cache if we got actual content
            // This prevents "null" results from overwriting old good data
            const hasData = data && (
                (data.data && data.data.length > 0) ||
                (data.popular && data.popular.length > 0) ||
                (Array.isArray(data) && data.length > 0) ||
                (data.status === 'success' && !Array.isArray(data)) // for details
            );

            if (hasData) {
                console.log(`[SWR] Successfully updated: ${key}`);
                apiCache.set(key, { data, timestamp: Date.now() });
            } else {
                console.warn(`[SWR] Refused to update ${key} with empty/null data`);
            }
        }).catch(err => {
            console.error(`[SWR ERROR] ${key}:`, err.message);
        });
        // Return stale data immediately
        return cached.data;
    }

    // 4. Otherwise, start a new fetch (blocking)
    console.log(`[CACHE MISS] Fetching fresh data for: ${key}`);
    const promise = fetcher();
    apiCache.set(key, { ...cached, promise, timestamp: cached ? cached.timestamp : 0 });

    try {
        const data = await promise;

        // Validation: If it's home/ongoing/latest and is empty, we might want to check if it's an error
        const isEmpty = data && (
            (data.data && data.data.length === 0 && (!data.popular || data.popular.length === 0)) ||
            (Array.isArray(data) && data.length === 0)
        );

        if (isEmpty && (key.includes('home') || key.includes('ongoing') || key.includes('latest'))) {
            console.warn(`[CACHE] Fetched empty data for ${key}, not caching strictly...`);
            // We set it but with a very short TTL so we try again soon
            apiCache.set(key, { data, timestamp: Date.now() - (CACHE_TTL - 30000) });
        } else {
            apiCache.set(key, { data, timestamp: Date.now() });
        }

        return data;
    } catch (error) {
        // If we had stale data, keep it on error instead of deleting
        if (cached && cached.data) {
            console.log(`[CACHE] Recovered from error using stale data for: ${key}`);
            apiCache.set(key, { data: cached.data, timestamp: cached.timestamp });
            return cached.data;
        }
        apiCache.delete(key);
        throw error;
    }
};

// --- BACKGROUND CACHE WARMING ---
// VPS-optimized: Longer interval (20 min) to save CPU/RAM
const warmUpCache = async () => {
    console.log('🔥 Warming up cache for popular routes...');
    try {
        await getCachedData('home-1', () => scraper.getHome(1), true);
        await getCachedData('home-2', () => scraper.getHome(2), true);
        await getCachedData('ongoing-1', () => scraper.getOngoing(1), true);
        await getCachedData('latest-only-1', () => scraper.getLatest(1), true);
        console.log('✅ Cache warmed up successfully');
    } catch (err) {
        console.error('⚠️ Cache warming failed:', err.message);
    }
};

// Warm up every 20 minutes (VPS optimized, was 10 min)
setInterval(warmUpCache, 20 * 60 * 1000);
// Warm up immediately on start
warmUpCache();

// --- Memory monitoring for 1GB VPS ---
setInterval(() => {
    const used = process.memoryUsage();
    const heapMB = Math.round(used.heapUsed / 1024 / 1024);
    const rssMB = Math.round(used.rss / 1024 / 1024);

    if (rssMB > 350) {
        console.warn(`⚠️ High memory usage: RSS=${rssMB}MB, Heap=${heapMB}MB, Cache=${apiCache.size} entries`);
        // Auto-cleanup old cache entries
        const now = Date.now();
        for (const [key, value] of apiCache.entries()) {
            if (now - value.timestamp > STALE_TTL) {
                apiCache.delete(key);
            }
        }
    }
}, 5 * 60 * 1000); // Check every 5 minutes

// --- API Endpoints ---

app.get(['/api/home', '/api/home/:page'], async (req, res) => {
    const page = req.params.page || 1;
    const refresh = req.query.refresh === 'true';
    const cacheKey = `home-${page}`;

    try {
        if (refresh) {
            console.log('[FORCE REFRESH] Re-checking active source...');
            await scraper._checkActiveSource();
        }

        const data = await getCachedData(cacheKey, () => scraper.getHome(page), refresh);
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
        res.json({
            status: 'success',
            latest_release: data.data || [],
            popular_today: data.popular || []
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.get(['/api/ongoing', '/api/ongoing/:page'], async (req, res) => {
    const page = req.params.page || 1;
    const refresh = req.query.refresh === 'true';
    const cacheKey = `ongoing-${page}`;

    try {
        const data = await getCachedData(cacheKey, () => scraper.getOngoing(page), refresh);
        res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=120');
        res.json({
            status: 'success',
            ongoing_donghua: data.data || []
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.get(['/api/completed', '/api/completed/:page'], async (req, res) => {
    const page = req.params.page || 1;
    const cacheKey = `completed-${page}`;

    try {
        const data = await getCachedData(cacheKey, () => scraper.getCompleted(page));
        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
        res.json({
            status: 'success',
            completed_donghua: data.data
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.get(['/api/latest', '/api/latest/:page'], async (req, res) => {
    const page = req.params.page || 1;
    const cacheKey = `latest-only-${page}`;

    try {
        const data = await getCachedData(cacheKey, () => scraper.getLatest(page));
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
        res.json({
            status: 'success',
            latest_release: data.data
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.get('/api/genres', async (req, res) => {
    try {
        const data = await getCachedData('genres-list', () => scraper.getGenres());
        res.setHeader('Cache-Control', 's-maxage=86400');
        res.json(data);
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.get(['/api/genres/:slug', '/api/genres/:slug/:page'], async (req, res) => {
    const { slug, page } = req.params;
    const cacheKey = `genre-${slug}-${page || 1}`;

    try {
        const data = await getCachedData(cacheKey, () => scraper.getByGenre(slug, page || 1));
        res.setHeader('Cache-Control', 's-maxage=3600');
        res.json(data);
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.get(['/api/az-list/:slug', '/api/az-list/:slug/:page'], async (req, res) => {
    const { slug, page } = req.params;
    const cacheKey = `az-${slug}-${page || 1}`;

    try {
        const data = await getCachedData(cacheKey, () => scraper.getByLetter(slug, page || 1));
        res.setHeader('Cache-Control', 's-maxage=86400');
        res.json(data);
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.get(['/api/seasons/:year', '/api/seasons/:year/:page'], async (req, res) => {
    const { year, page } = req.params;
    const cacheKey = `season-${year}-${page || 1}`;

    try {
        const data = await getCachedData(cacheKey, () => scraper.getBySeason(year, page || 1));
        res.setHeader('Cache-Control', 's-maxage=86400');
        res.json(data);
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.get('/api/schedule', async (req, res) => {
    try {
        const data = await getCachedData('schedule', () => scraper.getSchedule());
        const formatted = (data.data || []).map(item => ({
            day: item.day,
            donghua_list: item.items.map(anime => ({
                title: anime.title,
                href: `/anime/${anime.slug}`,
                episode: 'New'
            }))
        }));
        res.setHeader('Cache-Control', 's-maxage=3600');
        res.json({ status: 'success', schedule: formatted });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.get('/api/detail/:slug', async (req, res) => {
    const { slug } = req.params;

    try {
        const data = await getCachedData(`detail-${slug}`, () => scraper.getDetail(slug));

        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = req.get('host');
        const fullUrl = `${protocol}://${host}${req.originalUrl}`;

        const notFoundData = {
            title: "Data Tidak Ditemukan",
            poster: fullUrl,
            synopsis: "Donghua yang kamu cari tidak tersedia atau terjadi kesalahan saat mengambil data.",
            rating: "-",
            status: "Error",
            type: "-",
            studio: "-",
            released: "-",
            duration: "-",
            episodes_count: "0",
            genres: [],
            episodes_list: [],
            info: {},
            error: true,
            message: "Donghua tidak ditemukan"
        };

        if (data.status === 'success' &&
            data.data.title &&
            !data.data.title.toLowerCase().includes('tutorial') &&
            !data.data.title.toLowerCase().includes('cara melewati')) {
            res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
            res.json(data.data);
        } else {
            res.json(notFoundData);
        }
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.get('/api/episode/:slug', async (req, res) => {
    const { slug } = req.params;
    const cacheKey = `episode-${slug}`;

    try {
        console.log(`[API] Fetching episode: ${slug}`);
        const data = await getCachedData(cacheKey, () => scraper.getEpisode(slug));

        if (data.status === 'success') {
            console.log(`[API] Success fetching ${slug}`);
            res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=3600');
            res.json(data.data);
        } else {
            res.status(404).json(data);
        }
    } catch (err) {
        console.error(`[API] Error fetching ${slug}: ${err.message}`);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.get(['/api/search/:keyword', '/api/search/:keyword/:page'], async (req, res) => {
    const { keyword, page } = req.params;
    const refresh = req.query.refresh === 'true';
    const cacheKey = `search-${keyword}-${page || 1}`;

    try {
        const data = await getCachedData(cacheKey, () => scraper.search(keyword, page || 1), refresh);
        res.setHeader('Cache-Control', 's-maxage=600');
        res.json({
            status: 'success',
            data: data.data || []
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Status endpoint - useful for health checks
app.get('/api/status', async (req, res) => {
    const used = process.memoryUsage();
    const status = {
        status: 'online',
        server: 'VPS',
        active_source: scraper.ACTIVE_SOURCE_URL || 'Unknown',
        timestamp: new Date().toISOString(),
        uptime: Math.round(process.uptime()) + 's',
        memory: {
            rss: Math.round(used.rss / 1024 / 1024) + 'MB',
            heap: Math.round(used.heapUsed / 1024 / 1024) + 'MB'
        },
        cache_size: apiCache.size,
        connection_stats: scraper.LAST_CONNECTION_STATUS || {}
    };
    res.json(status);
});

// API Documentation Page
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

app.listen(PORT, async () => {
    console.log(`🚀 DonghuaWatch VPS API is running on http://localhost:${PORT}`);
    console.log(`📋 Environment: ${process.env.NODE_ENV || 'development'}`);
    try {
        await scraper._checkActiveSource();
    } catch (e) {
        console.error("Failed to check active source on startup");
    }
});
