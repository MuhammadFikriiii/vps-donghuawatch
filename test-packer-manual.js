const fs = require('fs');

function extractPackerArgs(html) {
    const evalMatch = html.match(/eval\(function\(p,a,c,k,e,d\)\{.*?\}\((.*)\)\)/s);
    if (!evalMatch) return null;

    const argsStr = evalMatch[1];
    console.log('ARGS STR LENGTH:', argsStr.length);

    // Find the last .split('|')
    const splitPattern = /\.split\(['"]\|['"]\)/;
    const splitMatch = argsStr.match(splitPattern);
    if (!splitMatch) return null;

    const splitIndex = argsStr.lastIndexOf(splitMatch[0]);
    const kEnd = argsStr.lastIndexOf("'", splitIndex);
    const kStart = argsStr.lastIndexOf("'", kEnd - 1);
    const k = argsStr.substring(kStart + 1, kEnd).split('|');

    const remaining = argsStr.substring(0, kStart).trim();
    // Remaining should end with ", radix, count, "
    const paramsMatch = remaining.match(/,\s*(\d+)\s*,\s*(\d+)\s*,\s*$/);
    if (!paramsMatch) {
        console.log('PARAMS MATCH FAILED ON:', remaining.slice(-50));
        return null;
    }

    const a = parseInt(paramsMatch[1]);
    const c = parseInt(paramsMatch[2]);

    const pPart = remaining.substring(0, paramsMatch.index).trim();
    const p = pPart.substring(1, pPart.length - 1); // Remove quotes

    return { p, a, c, k };
}

const html = fs.readFileSync('d:/My-Website/donghuawatch/streamruby_debug.html', 'utf8');
const args = extractPackerArgs(html);
if (args) {
    console.log('✅ Found Args!');
    console.log('Radix:', args.a, 'Count:', args.c);
    // Try to unpack
    function unpack(p, a, c, k) {
        while (c--) {
            if (k[c]) {
                const search = new RegExp('\\b' + c.toString(a) + '\\b', 'g');
                p = p.replace(search, k[c]);
            }
        }
        return p;
    }
    const unpacked = unpack(args.p, args.a, args.c, args.k);
    const m3u8 = unpacked.match(/https?:\/\/[^"']+\.m3u8[^"']*/i);
    console.log('RESULT M3U8:', m3u8 ? m3u8[0] : '❌ Not found in unpacked');
} else {
    console.log('❌ Extraction failed');
}
