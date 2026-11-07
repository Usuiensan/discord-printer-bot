import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrintJob } from '../src/discordContent.js';

const config = {
  printWidthDots: 384,
  printHeader: false,
  printAuthorAvatar: false,
  messageCommandPrefix: '!',
  cutMode: 'partial',
  cutFeedLines: 3,
  printUrlQr: false,
  textRenderMode: 'text',
  emojiRenderMode: 'text'
};

function message(content) {
  return { content, attachments: [], embeds: [], stickers: [], messageSnapshots: [] };
}

test('omitCut suppresses the final cut for the normal, note, and receipt-line paths', async () => {
  for (const content of ['本文', '!note 60\n本文', '!receiptline\n本文']) {
    const job = await buildPrintJob(message(content), config, { omitCut: true, printHeader: false });
    assert.equal(job.bytes.includes(Buffer.from([0x1b, 0x69])), false, content);
  }
});
