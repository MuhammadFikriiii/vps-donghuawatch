const axios = require('axios');

async function testStreamruby() {
    const start = Date.now();
    // Salah satu link embed yang penuh iklan
    const embedUrl = 'https://rubyvidhub.com/embed-ym4ixrltq1vg.html';

    console.log(`🚀 Mencoba tembus server Streamruby: ${embedUrl}`);

    try {
        const res = await axios.get(embedUrl, {
            headers: {
                'Referer': 'https://anichin.moe/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
            },
            timeout: 8000
        });

        // Di Streamruby, link m3u8 biasanya ada di script tag dalam format jwplayer/videojs
        const html = res.data;
        const m3u8Match = html.match(/file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i);

        const end = Date.now();
        console.log(`⏱️ Waktu eksekusi: ${end - start}ms`);

        if (m3u8Match) {
            console.log(`✅ BERHASIL! Link Bersih Ditemukan:`);
            console.log(m3u8Match[1]);
            console.log(`\n💡 Link ini bisa langsung kita putar di website DonghuaWatch kamu tanpa kluar iklan sama sekali.`);
        } else {
            console.log(`❌ Link m3u8 tidak ditemukan di source code awal. Mungkin dienkripsi.`);
            // Cari pola alternatif
            const scriptMatch = html.match(/p,a,c,k,e,d/);
            if (scriptMatch) console.log(`💡 Wah, script-nya di-protect (packed). Tapi tenang, VPS bisa bongkar ini!`);
        }

    } catch (e) {
        console.error(`❌ Error koneksi: ${e.message}`);
    }
}

testStreamruby();
