const axios = require('axios');
const cheerio = require('cheerio');

async function test() {
    const url = 'https://anichin.moe';
    try {
        const res = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
            }
        });
        const $ = cheerio.load(res.data);
        const l_box = $('.latesthome').closest('.bixbox');
        const h_box = $('.hothome').closest('.bixbox');

        console.log('LATEST_ITEMS_COUNT:', l_box.find('article.bs').length);
        console.log('HOT_ITEMS_COUNT:', h_box.find('article.bs').length);
        console.log('TOTAL_BS:', $('article.bs').length);

        // Find where those 49 items are
        $('.bixbox').each((i, el) => {
            const h = $(el).find('h1, h2, h3').first().text().trim();
            const count = $(el).find('article.bs').length;
            if (count > 0) console.log(`Box ${i} [${h}]: ${count} items`);
        });

    } catch (e) {
        console.error('Error:', e.message);
    }
}

test();
