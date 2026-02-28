const resolver = require('./resolver');

async function testOkru() {
    const url = 'https://ok.ru/videoembed/7036494318314'; // Example
    const result = await resolver.resolveOkru(url);
    console.log('OKRU RESULT:', typeof result, result);
}

testOkru();
