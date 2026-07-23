import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  buildAuthorHeaderImage,
  buildNoteRasterImages,
  parseNoteMessageCommand,
  wrapHeaderDisplayName
} from '../src/discordContent.js';

const config = {
  printWidthDots: 384,
  printAuthorAvatar: false,
  authorAvatarWidthDots: 96,
  printFontFamily: 'sans-serif',
  textImageFontFamily: 'sans-serif',
  textImageFontSizeDots: 28,
  textImageLineHeightDots: 30,
  textImageLineGapDots: 6,
  textImageThreshold: 170
};

test('note90 treats the argument as logical line width in dots', async () => {
  const command = parseNoteMessageCommand('!note90 360\n'.concat('日本語'.repeat(100)));
  assert.deepEqual(command?.rotate90, true);
  assert.equal(command?.widthDots, 360);

  const images = await buildNoteRasterImages(command, config);
  assert.ok(images.length >= 2);
  for (const image of images) {
    const metadata = await sharp(image).metadata();
    assert.ok((metadata.width ?? 0) <= 384);
    assert.equal(metadata.height, 360);
  }
});

test('note uses the requested narrow width without rotation', async () => {
  const command = parseNoteMessageCommand('!note 30\n日本語ABC');
  const [image] = await buildNoteRasterImages(command, config);
  const metadata = await sharp(image).metadata();
  assert.equal(metadata.width, 30);
  assert.ok((metadata.height ?? 0) > 36);
});

test('note clamps widths larger than the printable area to 384 dots', async () => {
  const command = parseNoteMessageCommand('!note 800\n印字可能幅に収める');
  const [image] = await buildNoteRasterImages(command, config);
  const metadata = await sharp(image).metadata();
  assert.equal(metadata.width, 384);
});

test('long Discord names wrap completely and extend the header', async () => {
  const name = '非常に長いDiscord表示名を最後まで省略せず印字するユーザー';
  const lines = wrapHeaderDisplayName(name, 120);
  assert.ok(lines.length > 1);
  assert.equal(lines.join(''), name);

  const image = await buildAuthorHeaderImage({
    author: {
      id: '1',
      username: name,
      displayAvatarURL: () => ''
    },
    createdAt: new Date('2026-07-23T00:00:00Z')
  }, config, 1);
  const metadata = await sharp(image).metadata();
  assert.ok((metadata.height ?? 0) > 124);
});
