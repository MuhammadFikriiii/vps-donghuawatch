const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const scraper = require('./scraper');
const resolver = require('./resolver');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// --- FIREBASE ADMIN INITIALIZATION ---
try {
    const keyPath = path.join(__dirname, 'firebase-key.json');
    if (fs.existsSync(keyPath)) {
        const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log('✅ Firebase Admin SDK Initialized (Using firebase-key.json)');
    } else {
        console.warn('⚠️ No firebase-key.json found. Push notifications disabled.');
    }
} catch (err) {
    console.error('❌ Firebase Init Error:', err.message);
}

// --- Supabase Configuration (Cepat & Mantap) ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

if (!supabase) {
    console.warn('[DB WARNING] Supabase not configured. Persistent cache is OFF.');
} else {
    // Verifikasi koneksi ke Supabase saat start
    supabase.from('premium_cache').select('slug').limit(1).then(({ error }) => {
        if (error) console.error('[DB ERROR] Supabase connection failed:', error.message);
        else console.log('✅ Supabase connected and ready to save data.');
    });
}

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
    max: 1000, // Dinaikkan ke 1000 sesuai keinginan user, sangat aman untuk IP publik/shared
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        status: 'error',
        message: 'Too many requests, please try again later.'
    },
    skip: (req, res) => {
        const origin = req.headers.origin || '';
        const referer = req.headers.referer || '';
        // Skip rate limit jika berasal dari domain resmi kita
        return allowedOrigins.some(o => origin.includes(o) || referer.includes(o));
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
const checkNewEpisodes = async (latestItems) => {
    if (!latestItems || !latestItems.length || !supabase) return;

    const latest = latestItems[0];
    const { data: setting } = await supabase
        .from('site_settings')
        .select('value')
        .eq('key', 'last_notified_slug')
        .single();

    const lastSlug = setting?.value;

    if (lastSlug && lastSlug !== latest.slug) {
        console.log(`[AUTO PUSH] 🚀 Detecting new release: ${latest.title}`);

        // Prepare Message
        const title = `Update Episode Baru! 🎬`;
        const message = `${latest.title} sudah rilis. Yuk tonton sekarang di DonghuaWatch!`;

        try {
            console.log(`[AUTO PUSH] 🚀 Sending: ${title} | ${message}`);

            // Send to 'all' topic (Semua user yang subscribe ke topic 'all')
            await admin.messaging().send({
                topic: 'all',
                notification: {
                    title: title,
                    body: message
                },
                android: {
                    priority: 'high',
                    notification: {
                        sound: 'default'
                    }
                }
            });

            // Update last notified slug in DB
            await supabase.from('site_settings').upsert({
                key: 'last_notified_slug',
                value: latest.slug,
                updated_at: new Date()
            }, { onConflict: 'key' });

            // CRITICAL: Invalidate the Detail cache for this anime!
            // Episode slug format: tales-of-herding-god-subtitle-indonesia-episode-72
            // We want: tales-of-herding-god
            const animeSlug = latest.slug
                .replace(/-subtitle-indonesia/, '')
                .replace(/-episode-\d+$/, '')
                .replace(/-episode-/, '');

            console.log(`[AUTO CACHE] 🧹 Clearing cache for anime: ${animeSlug}`);
            apiCache.delete(`detail-${animeSlug}`);
            await supabase.from('anime_metadata').delete().eq('slug', animeSlug);

            console.log(`[AUTO PUSH] ✅ Successfully sent to 'all' topic and cleared cache for ${animeSlug}`);

        } catch (err) {
            console.error('[AUTO PUSH ERROR]', err.message);
        }
    } else if (!lastSlug) {
        // First time initialization
        await supabase.from('site_settings').upsert({
            key: 'last_notified_slug',
            value: latest.slug,
            updated_at: new Date()
        }, { onConflict: 'key' });
    }
};

// VPS-optimized: Longer interval (20 min) to save CPU/RAM
const warmUpCache = async () => {
    console.log('🔥 Warming up cache for popular routes...');
    try {
        const home1 = await getCachedData('home-1', () => scraper.getHome(1), true);
        await getCachedData('home-2', () => scraper.getHome(2), true);
        await getCachedData('ongoing-1', () => scraper.getOngoing(1), true);
        await getCachedData('latest-only-1', () => scraper.getLatest(1), true);

        // Trigger Auto Notification Check
        if (home1 && home1.data) {
            await checkNewEpisodes(home1.data);
        }

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
        // 1. CEK DB METADATA (SUPABASE)
        const forceRefresh = req.query.refresh === 'true';

        if (supabase && !forceRefresh) {
            try {
                const { data: dbData, error } = await supabase
                    .from('anime_metadata')
                    .select('*')
                    .eq('slug', slug)
                    .single();

                // Pastikan data ada dan tidak rusak
                if (dbData && !error && dbData.episodes && dbData.episodes.length > 0) {
                    const lastUpdate = new Date(dbData.updated_at);
                    const now = new Date();
                    const diffMinutes = (now - lastUpdate) / (1000 * 60);

                    // Ambil status dari metadata (default ongoing jika tidak ada)
                    const status = (dbData.metadata?.status || 'ongoing').toLowerCase();
                    const isOngoing = status.includes('ongoing');

                    // SMART TTL: 10 Menit untuk Ongoing (Biar Episode Baru Cepat Muncul)
                    // 24 Jam untuk Tamat
                    const ttlMinutes = isOngoing ? 10 : (24 * 60);

                    if (diffMinutes < ttlMinutes) {
                        console.log(`[DETAIL] 🎯 HIT DATABASE: ${slug} (${diffMinutes.toFixed(1)}m old, Status: ${status})`);

                        return res.json({
                            ...dbData.metadata,
                            title: dbData.title,
                            poster: dbData.poster,
                            synopsis: dbData.synopsis,
                            episodes_list: dbData.episodes,
                            genres: dbData.metadata?.genres || [],
                            status: 'success',
                            is_cached: true,
                            last_updated: dbData.updated_at,
                            next_refresh_min: Math.max(0, (ttlMinutes - diffMinutes).toFixed(1))
                        });
                    }
                    console.log(`[DETAIL] 🔄 Cache expired for ${slug} (${diffMinutes.toFixed(1)}m old, Status: ${status}), re-scraping...`);
                }
            } catch (e) { }
        } else if (forceRefresh) {
            console.log(`[DETAIL] 🚀 Force refresh requested for: ${slug}`);
        }

        // 2. SCRAPE JIKA TDK ADA DI DB ATAU EXPIRED
        const data = await getCachedData(`detail-${slug}`, () => scraper.getDetail(slug), forceRefresh);

        if (data.status === 'success' && data.data.title) {
            // 3. SIMPAN KE DB (BACKGROUND)
            if (supabase) {
                const meta = data.data;
                supabase.from('anime_metadata').upsert({
                    slug: slug,
                    title: meta.title,
                    synopsis: meta.synopsis,
                    poster: meta.poster,
                    metadata: meta.info || {},
                    episodes: meta.episodes_list || [],
                    updated_at: new Date()
                }).then(({ error }) => {
                    if (error) console.error('[DB ERROR] Detail Save failed:', error.message);
                    else console.log(`[DB] 💾 Detail cached for: ${slug}`);
                });
            }

            res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
            res.json(data.data);
        } else {
            res.json({
                status: 'error',
                message: "Detail tidak ditemukan"
            });
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

        if (data.status === 'success' && data.data) {
            const epData = data.data;

            // 💡 FIX: JIKA LIST EPISODE KOSONG, COBA AMBIL DARI DATABASE METADATA SERINYA
            const seriesSlug = epData.donghua_details?.slug;
            if ((!epData.episodes_list || epData.episodes_list.length === 0) && seriesSlug && supabase) {
                try {
                    const { data: dbMeta } = await supabase
                        .from('anime_metadata')
                        .select('episodes')
                        .eq('slug', seriesSlug)
                        .single();

                    if (dbMeta?.episodes) {
                        console.log(`[EPISODE] 🎯 Restored Playlist from DB for: ${slug}`);
                        epData.episodes_list = dbMeta.episodes;
                    }
                } catch (dbErr) { }
            }

            res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=3600');
            res.json(epData);
        } else {
            res.status(404).json(data);
        }
    } catch (err) {
        console.error(`[API] Error fetching ${slug}: ${err.message}`);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * PREMIUM STREAM RESOLVER ENDPOINT (ULTRA FAST)
 */
app.get('/api/premium/stream/:slug', async (req, res) => {
    const { slug } = req.params;
    const cacheKey = `premium-stream-${slug}`;

    try {
        const startTimeTotal = Date.now();

        // 1. CEK PERSISTENT CACHE (SUPABASE) - SECEPAT KILAT
        if (supabase) {
            try {
                const { data, error } = await supabase
                    .from('premium_cache')
                    .select('*')
                    .eq('slug', slug)
                    .single();

                if (data && !error) {
                    // Cek apakah data masih fresh (misal 24 jam)
                    const createdNode = new Date(data.created_at);
                    const now = new Date();
                    const hoursDiff = (now - createdNode) / (1000 * 60 * 60);

                    if (hoursDiff < 24) {
                        console.log(`[PREMIUM] 🎯 HIT SUPABASE: ${slug} (Instant Load)`);
                        return res.json({
                            status: 'success',
                            stream_url: data.stream_url,
                            qualities: data.qualities,
                            provider: data.provider,
                            resolved_in: 'DATABASE (0.1s)',
                            is_cached: true
                        });
                    } else {
                        console.log(`[PREMIUM] 🔄 Cache expired for ${slug} (${hoursDiff.toFixed(1)}h old), re-resolving...`);
                    }
                } else if (error && error.code !== 'PGRST116') { // PGRST116 is "No rows found"
                    console.warn(`[DB WARNING] Supabase query error: ${error.message}`);
                }
            } catch (dbErr) {
                console.error('[DB ERROR] Failed to fetch cache:', dbErr.message);
            }
        } else {
            console.warn('[DB WARNING] Supabase is not configured, skipping persistent cache.');
        }

        const cached = await getCachedData(cacheKey, async () => {
            const startTime = Date.now();
            console.log(`[PREMIUM] ⚡ Memulai resolusi cepat untuk: ${slug}`);

            // 1. REUSE EPISODE CACHE (Kunci Kecepatan)
            let epData = null;
            const cachedEp = apiCache.get(`episode-${slug}`);
            if (cachedEp && cachedEp.data) {
                console.log('[PREMIUM] Reuse existing episode cache');
                epData = cachedEp.data;
            } else {
                console.log('[PREMIUM] No episode cache, fetching fresh episode details...');
                const raw = await scraper.getEpisode(slug);
                if (raw && raw.status === 'success') {
                    epData = raw;
                    // Cache it manually for future use
                    apiCache.set(`episode-${slug}`, { data: raw, timestamp: Date.now() });
                }
            }

            if (!epData || epData.status !== 'success' || !epData.data) {
                console.error(`[PREMIUM ERROR] Episode data invalid for ${slug}:`, epData);
                throw new Error('Episode data not found or invalid');
            }

            const servers = epData.data.streaming?.servers || [];
            if (servers.length === 0) {
                console.error(`[PREMIUM ERROR] No servers found for ${slug}`);
                throw new Error('No servers available for this episode');
            }

            console.log(`[PREMIUM] Found ${servers.length} servers. Starting parallel resolution...`);

            // 2. Parallel Tasks
            const tasks = [];

            // Task Streamruby
            const ruby = servers.find(s => s.url.includes('ruby') || s.url.includes('streamruby') || s.url.includes('rubyvid'));
            if (ruby) {
                tasks.push((async () => {
                    const link = await resolver.resolveStreamruby(ruby.url);
                    if (!link) throw new Error('Ruby Resolution Failed');
                    return { link, provider: 'Streamruby' };
                })());
            }

            // Task Okru
            const okru = servers.find(s => s.url.includes('ok.ru'));
            if (okru) {
                tasks.push((async () => {
                    const link = await resolver.resolveOkru(okru.url);
                    if (!link) throw new Error('Okru Resolution Failed');
                    return { link, provider: 'Okru' };
                })());
            }

            // Task Generic Sniffing
            const others = servers.filter(s => !s.url.includes('ruby') && !s.url.includes('ok.ru'));
            others.slice(0, 2).forEach(s => {
                tasks.push((async () => {
                    console.log(`[PREMIUM] Trying generic sniff for: ${s.name}`);
                    const html = await resolver._robustFetch(s.url);
                    const link = resolver.sniffGeneric(html);
                    if (!link) throw new Error(`Sniff failed for ${s.name}`);
                    return { link, provider: s.name || 'Sniff' };
                })());
            });

            if (tasks.length === 0) throw new Error('No compatible premium servers found');

            try {
                const result = await Promise.any(tasks);
                const duration = ((Date.now() - startTime) / 1000).toFixed(2);
                console.log(`[PREMIUM SUCCESS] 🚀 Super-Fast dlm ${duration}s via ${result.provider}`);

                // Handle Multi-Quality (Array) vs Single URL (String)
                const isMulti = Array.isArray(result.link);
                const finalQualities = isMulti ? result.link : null;
                const finalStreamUrl = isMulti ? result.link[0].url : result.link;

                const responseData = {
                    status: 'success',
                    stream_url: finalStreamUrl,
                    qualities: finalQualities,
                    provider: result.provider,
                    resolved_in: `${duration}s`
                };

                // 💾 SIMPAN KE SUPABASE SUPAYA INSTAN BUAT USER BERIKUTNYA
                if (supabase) {
                    supabase.from('premium_cache').upsert({
                        slug: slug,
                        stream_url: finalStreamUrl,
                        qualities: finalQualities,
                        provider: result.provider,
                        resolved_in: `${duration}s`,
                        updated_at: new Date()
                    }).then(({ error }) => {
                        if (error) console.error('[DB ERROR] Save cache failed:', error.message);
                        else console.log(`[PREMIUM] 💾 Data saved to Supabase for: ${slug}`);
                    });
                }

                return responseData;
            } catch (err) {
                // Better AggregateError logging
                if (err.name === 'AggregateError') {
                    console.error(`[PREMIUM] All resolution providers failed for ${slug}:`, err.errors.map(e => e.message));
                }
                throw err;
            }
        });
        res.json(cached);
    } catch (err) {
        console.error(`[PREMIUM ERROR] ${slug}:`, err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * ULTRA SMARTER HLS CORS PROXY
 * Fixes CORS and relative path issues in manifests, LINE BY LINE parsing.
 */
app.get('/api/proxy/hls', async (req, res) => {
    const streamUrl = req.query.url;
    if (!streamUrl) return res.status(400).send('No URL provided');

    try {
        const axios = require('axios'); // Pastikan axios sudah di-import di atas
        const response = await axios.get(streamUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Referer': 'https://ok.ru/',
                'Accept': '*/*'
            },
            timeout: 10000
        });

        let content = response.data;

        // Jika response adalah manifest m3u8
        if (typeof content === 'string' && (content.includes('#EXTM3U') || content.includes('#EXT-X-STREAM-INF'))) {

            // Dapatkan base URL dari server API kamu saat ini
            const protocol = req.headers['x-forwarded-proto'] || req.protocol;
            const host = req.get('host');
            const proxyBase = `${protocol}://${host}/api/proxy/hls?url=`;

            // FIX UTAMA: Parsing baris per baris agar URL HLS anak tidak lolos dari Proxy
            content = content.split('\n').map(line => {
                const trimmedLine = line.trim();

                // Abaikan baris kosong atau baris metadata HLS (#)
                if (!trimmedLine || trimmedLine.startsWith('#')) return line;

                try {
                    // Jadikan URL absolut (baik asalnya relatif maupun sudah absolut)
                    const absoluteUrl = new URL(trimmedLine, streamUrl).href;

                    // PROXY ULANG jika mengarah ke .m3u8 lain (resolusi 1080p, 720p, dll)
                    if (absoluteUrl.includes('.m3u8')) {
                        return proxyBase + encodeURIComponent(absoluteUrl);
                    }

                    // Untuk file .ts (potongan video), kembalikan URL absolut aslinya (Bypass Proxy)
                    // Ini penting agar bandwidth VPS kamu tidak terkuras!
                    return absoluteUrl;
                } catch (e) {
                    // Jika gagal parsing URL, kembalikan teks aslinya
                    return line;
                }
            }).join('\n');

            res.setHeader('Content-Type', 'application/x-mpegURL');
            res.setHeader('Access-Control-Allow-Origin', '*');
            return res.send(content);
        }

        // Untuk file lain yang bukan m3u8, stream/redirect saja
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.redirect(streamUrl);
    } catch (err) {
        console.error('[PROXY ERROR]', err.message);
        res.status(500).send('Proxy Failed');
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

/**
 * PUSH NOTIFICATION ENDPOINT
 * Handles manual messages from Admin Panel
 */
app.post('/api/push-notification', async (req, res) => {
    const { title, message } = req.body;

    if (!title || !message) {
        return res.status(400).json({ status: 'error', message: 'Title and message are required' });
    }

    try {
        console.log(`[PUSH NOTIF] Sending Manual Notification: "${title}" - "${message}"`);

        await admin.messaging().send({
            topic: 'all',
            notification: {
                title: title,
                body: message
            },
            android: {
                priority: 'high',
                notification: {
                    sound: 'default'
                }
            }
        });

        res.json({ status: 'success', message: 'Notification sent to all users' });
    } catch (err) {
        console.error('[PUSH ERROR]', err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
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
