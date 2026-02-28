const axios = require('axios');
const fs = require('fs');

async function debugOkru() {
    const videoId = '11448216062642';
    const mobileUrl = `https://m.ok.ru/video/${videoId}`;
    try {
        const res = await axios.get(mobileUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1' }
        });
        fs.writeFileSync('okru_debug.html', res.data);
        console.log('OKRU HTML saved.');
    } catch (e) {
        console.error(e.message);
    }
}
debugOkru();
