const resolver = require('./resolver');

async function runTest() {
    console.log('--- 🧪 PREMIUM RESOLVER LOCAL TEST ---');

    // 1. Test Streamruby (Link dari browser subagent tadi)
    const streamrubyUrl = 'https://rubyvidhub.com/embed-ym4ixrltq1vg.html';
    const streamrubyRes = await resolver.resolveStreamruby(streamrubyUrl);
    console.log('\n[Streamruby]');
    console.log('Target:', streamrubyUrl);
    console.log('Result:', streamrubyRes ? `✅ ${streamrubyRes}` : '❌ Failed to extract link');

    // 2. Test Okru
    const okruUrl = 'https://ok.ru/videoembed/11448216062642';
    const okruRes = await resolver.resolveOkru(okruUrl);
    console.log('\n[Okru]');
    console.log('Target:', okruUrl);
    console.log('Result:', okruRes ? `✅ ${okruRes}` : '❌ Failed to extract link');

    console.log('\n--- 📝 Kesimpulan ---');
    if (streamrubyRes || okruRes) {
        console.log('Premium Resolver berfungsi secara lokal! Iklan asli provider tidak akan terpanggil karena kita cuma pake link video mentahnya saja.');
    } else {
        console.log('Beberapa server masih gagal di-resolve. Perlu penyesuaian Regex.');
    }
}

runTest();
