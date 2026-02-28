const axios = require('axios');
const fs = require('fs');

async function debugStreamruby() {
    const url = 'https://rubyvidhub.com/embed-ym4ixrltq1vg.html';
    try {
        const res = await axios.get(url, {
            headers: {
                'Referer': 'https://anichin.moe/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            }
        });
        fs.writeFileSync('streamruby_debug.html', res.data);
        console.log('HTML saved to streamruby_debug.html');

        const evalMatch = res.data.match(/eval\(function\(p,a,c,k,e,d\)\{.*?\}\((.*)\)\)/s);
        if (evalMatch) {
            console.log('Found eval block arguments:');
            console.log(evalMatch[1].substring(0, 200) + '...');
        } else {
            console.log('No eval block found.');
        }
    } catch (e) {
        console.error(e.message);
    }
}

debugStreamruby();
