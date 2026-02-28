const axios = require('axios');
const cheerio = require('cheerio');

/**
 * PREMIUM VIDEO RESOLVER MODULE v2.3
 * Menangani ekstraksi direct link dari berbagai provider video
 */
const resolver = {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Referer': 'https://anichin.moe/',
    },

    /**
     * Decode Dean Edwards Packer (p,a,c,k,e,d)
     */
    unpack: (p, a, c, k) => {
        while (c--) {
            if (k[c]) {
                const search = new RegExp('\\b' + c.toString(a) + '\\b', 'g');
                p = p.replace(search, k[c]);
            }
        }
        return p;
    },

    /**
     * SNIFF: Cari link video apapun dlm HTML
     */
    sniffGeneric: (html) => {
        const patterns = [
            /file\s*:\s*["'](https?:\/\/[^"']+\.(m3u8|mp4)[^"']*)["']/i,
            /src\s*:\s*["'](https?:\/\/[^"']+\.(m3u8|mp4)[^"']*)["']/i,
            /["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
            /["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i
        ];

        for (const pattern of patterns) {
            const match = html.match(pattern);
            if (match && !match[1].includes('analytics') && !match[1].includes('log')) {
                return match[1];
            }
        }
        return null;
    },

    /**
     * Resolve Streamruby / RubyVid
     */
    resolveStreamruby: async (url) => {
        try {
            console.log(`[RESOLVER] Resolving Streamruby: ${url}`);
            const res = await axios.get(url, { headers: resolver.headers, timeout: 10000 });
            const html = res.data;

            // 1. Cek m3u8 langsung
            let direct = resolver.sniffGeneric(html);
            if (direct && direct.includes('.m3u8')) return direct;

            // 2. Bongkar Packer
            const evalMatch = html.match(/eval\(function\(p,a,c,k,e,d\)\{.*?\}\((.*)\)\)/s);
            if (evalMatch) {
                const argsStr = evalMatch[1];

                // Manual Parse Arguments (Tangguh)
                const splitPattern = /\.split\(['"]\|['"]\)/;
                const splitMatch = argsStr.match(splitPattern);

                if (splitMatch) {
                    const splitIndex = argsStr.lastIndexOf(splitMatch[0]);
                    const kEnd = argsStr.lastIndexOf("'", splitIndex);
                    const kStart = argsStr.lastIndexOf("'", kEnd - 1);
                    const k = argsStr.substring(kStart + 1, kEnd).split('|');

                    const remaining = argsStr.substring(0, kStart).trim();
                    const paramsMatch = remaining.match(/,\s*(\d+)\s*,\s*(\d+)\s*,\s*$/);

                    if (paramsMatch) {
                        const a = parseInt(paramsMatch[1]);
                        const c = parseInt(paramsMatch[2]);
                        const pPart = remaining.substring(0, paramsMatch.index).trim();
                        const p = pPart.substring(1, pPart.length - 1); // Buang quotes hp

                        const unpacked = resolver.unpack(p, a, c, k);
                        const finalM3u8 = unpacked.match(/https?:\/\/[^"']+\.m3u8[^"']*/i);
                        if (finalM3u8) return finalM3u8[0];
                    }
                }
            }

            return null;
        } catch (e) {
            console.error('[RESOLVER ERROR] Streamruby:', e.message);
            return null;
        }
    },

    /**
     * Resolve Okru (ok.ru) with Multi-Quality support
     */
    resolveOkru: async (url) => {
        try {
            const videoId = url.split('/').pop().split('?')[0];
            console.log(`[RESOLVER] 🚀 Fast-Resolving Okru: ${videoId}`);

            // Jalur Super Cepat: Metadata API (Hanya 10KB vs 300KB HTML)
            const apiUrl = `https://ok.ru/dk?cmd=videoPlayerMetadata&mid=${videoId}`;
            const pcHeaders = {
                ...resolver.headers,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Referer': 'https://ok.ru/',
                'X-Requested-With': 'XMLHttpRequest'
            };

            const response = await axios.get(apiUrl, { headers: pcHeaders, timeout: 5000 });
            const metadata = response.data;

            if (metadata && metadata.videos) {
                const videos = metadata.videos;

                // 1. Prioritas HLS (Master Manifest)
                const hls = videos.find(v => v.name === 'hls' || (v.url && v.url.includes('.m3u8')));
                if (hls && hls.url) return hls.url;

                // 2. Multi-Quality MP4 List
                const qualityMap = {
                    'mobile': 144, 'lowest': 240, 'low': 360, 'sd': 480,
                    'hd': 720, 'full': 1080, 'quad': 1440, 'ultra': 2160, '4k': 2160
                };

                const qualities = videos
                    .filter(v => v.url && v.name)
                    .map(v => {
                        const lowName = v.name.toLowerCase();
                        const h = qualityMap[lowName] || parseInt(v.name) || 0;
                        return {
                            label: h > 0 ? h + 'p' : v.name,
                            height: h,
                            url: v.url
                        };
                    })
                    .filter(q => q.height > 0)
                    .sort((a, b) => b.height - a.height);

                if (qualities.length > 0) return qualities;
            }

            // Fallback: Jika API gagal, pakai scraping robust lama
            const fallbackRes = await axios.get(url, { headers: pcHeaders, timeout: 5000 });
            const html = fallbackRes.data;
            const $ = cheerio.load(html);
            const optionsStr = $('div[data-options]').attr('data-options');
            if (optionsStr) {
                const options = JSON.parse(optionsStr);
                const metadataFull = typeof options.flashvars.metadata === 'string' ? JSON.parse(options.flashvars.metadata) : options.flashvars.metadata;
                if (metadataFull && metadataFull.videos) {
                    const qualityMap = {
                        'mobile': 144, 'lowest': 240, 'low': 360, 'sd': 480,
                        'hd': 720, 'full': 1080, 'quad': 1440, 'ultra': 2160, '4k': 2160
                    };
                    return metadataFull.videos
                        .filter(v => v.url && v.name)
                        .map(v => {
                            const h = qualityMap[v.name.toLowerCase()] || parseInt(v.name) || 0;
                            return { label: h + 'p', height: h, url: v.url };
                        })
                        .filter(q => q.height > 0)
                        .sort((a, b) => b.height - a.height);
                }
            }

            return null;
        } catch (e) {
            console.error('[RESOLVER ERROR] Okru Fast-Path:', e.message);
            return null;
        }
    }
};

module.exports = resolver;
