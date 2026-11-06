import test from 'node:test';
import assert from 'node:assert/strict';
import iconv from 'iconv-lite';
import { buildPrintJob} from '../src/discordContent.js';

// Walk a built job's byte stream and report which font (ESC M / ESC! bit 0)
// was in effect for each text run. Command lengths follow the ESC/POS
// sequences EscPosBuilder emits for text-only jobs.
function fontRuns(bytes) {
const runs = [];
let font = 0;
let current = [];
const flush = () => {
if (current.length > 0) {
runs.push({ text: iconv.decode(Buffer.from(current), 'cp932'), font});
current = [];
}
};
for (let i = 0; i < bytes.length; i += 1) {
const b = bytes[i];
if (b === 0x1b) {
flush();
const command = bytes[i + 1];
if (command === 0x4d) font = bytes[i + 2];
if (command === 0x21) font = bytes[i + 2] & 1;
if (command === 0x40) font = 0;
if ([0x20, 0x2d, 0x33, 0x45, 0x4d, 0x56, 0x61, 0x21, 0x7b, 0x24, 0x5c].includes(command)) i += 2;
else if (command === 0x28) i += 5; // ESC ( C kanji type etc. (not in this stream, defensive)
else i += 1;
} else if (b === 0x1d) {
flush();
i += 2;
} else if (b === 0x1c) {
flush();
i += bytes[i + 1] === 0x26? 1: 2;
} else if (b === 0x0a || b === 0x0d) {
flush();
} else {
current.push(b);
}
}
flush();
return runs;
}

function baseConfig(rotate180) {
return {
printWidthDots: 384,
printHeader: false,
printAuthorAvatar: false,
messageCommandPrefix: '!',
cutMode: 'none',
cutFeedLines: 3,
printUrlQr: false,
textRenderMode: 'auto',
emojiRenderMode: 'text',
printRotate180: rotate180
};
}

const NEWS_MESSAGE = {
content: '【NHKニュース速報 13:54】\n食料品の消費税減税関連法案\n衆議院を通過\n自民・維新などの賛成多数で可決\n\n-# mastodon 情報源 13:54:31.807 / 送出 13:54:32.099',
attachments: [],
stickers: [],
messageSnapshots: [],
embeds: []
};

for (const rotate180 of [false, true]) {
test(`subtext (-#) footer is small, headlines stay normal (rotate180: ${rotate180})`, async () => {
const { bytes} = await buildPrintJob(NEWS_MESSAGE, baseConfig(rotate180), { printHeader: false});
const runs = fontRuns(bytes);
const footer = runs.find((run) => run.text.includes('mastodon'));
const headline = runs.find((run) => run.text.includes('食料品の消費税減税関連法案'));
const title = runs.find((run) => run.text.includes('ニュース速報'));
assert.ok(footer, 'footer run exists');
assert.ok(headline, 'headline run exists');
assert.equal(footer.font, 1, 'subtext footer prints in Font B');
assert.equal(headline.font, 0, 'headline prints in Font A');
assert.equal(title.font, 0, 'title prints in Font A');
});
}

test('explicit!font b command still selects Font B', async () => {
const message = {...NEWS_MESSAGE, content: '!font b\n小さい文字で出す行'};
const { bytes} = await buildPrintJob(message, baseConfig(false), { printHeader: false});
assert.equal(bytes.includes(Buffer.from([0x1b, 0x4d, 0x01])), true);
});
