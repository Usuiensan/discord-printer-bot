import sharp from 'sharp';

export async function renderVerticallyCenteredRaster({
  width,
  lineHeight,
  fontSize,
  threshold,
  buildSvg
}) {
  const sourceHeight = Math.max(lineHeight * 2, Math.ceil(fontSize * 2 + 8));
  const baselineY = Math.ceil(sourceHeight / 2 + fontSize * 0.35);
  const { data, info } = await sharp(buildSvg(sourceHeight, baselineY))
    .grayscale()
    .threshold(threshold)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { firstInkRow, lastInkRow } = findInkRows(data, info);
  if (firstInkRow < 0) {
    return whiteRasterPng(width, lineHeight);
  }

  const inkHeight = lastInkRow - firstInkRow + 1;
  // Keep a small white guard on both sides of the glyph. Some Japanese
  // glyphs reach the measured ink boundary, and a zero-dot edge margin can
  // lose the final raster rows when the printer advances to the next line.
  const verticalSafetyPadding = 2;
  const outputHeight = Math.max(lineHeight, inkHeight + verticalSafetyPadding * 2);
  const topPadding = Math.floor((outputHeight - inkHeight) / 2);
  const output = Buffer.alloc(width * outputHeight, 0xff);

  for (let row = 0; row < inkHeight; row += 1) {
    const sourceStart = (firstInkRow + row) * info.width;
    const targetStart = (topPadding + row) * width;
    data.copy(output, targetStart, sourceStart, sourceStart + width);
  }

  return sharp(output, {
    raw: { width, height: outputHeight, channels: 1 }
  }).png().toBuffer();
}

function findInkRows(data, info) {
  let firstInkRow = -1;
  let lastInkRow = -1;

  for (let y = 0; y < info.height; y += 1) {
    const rowStart = y * info.width;
    const rowEnd = rowStart + info.width;
    let hasInk = false;
    for (let index = rowStart; index < rowEnd; index += 1) {
      if (data[index] < 0xff) {
        hasInk = true;
        break;
      }
    }
    if (!hasInk) continue;
    if (firstInkRow < 0) firstInkRow = y;
    lastInkRow = y;
  }

  return { firstInkRow, lastInkRow };
}

function whiteRasterPng(width, height) {
  return sharp(Buffer.alloc(width * height, 0xff), {
    raw: { width, height, channels: 1 }
  }).png().toBuffer();
}
