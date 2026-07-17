import LineBreaker from 'linebreak';

const graphemeSegmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });

export function wrapUnicodeText(text, maxColumns, widthOf) {
  const limit = Math.max(1, Number(maxColumns) || 1);
  const lines = [];

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const { visibleText, styles } = parseDiscordStyles(rawLine);
    if (!visibleText) {
      lines.push(rawLine);
      continue;
    }

    const units = Array.from(graphemeSegmenter.segment(visibleText), (item) => ({
      text: item.segment,
      end: item.index + item.segment.length,
      ...(styles[item.index] ?? { bold: false, underline: false })
    }));
    const breakPositions = unicodeBreakPositions(visibleText);
    const segments = [];
    let segment = [];
    for (const unit of units) {
      segment.push(unit);
      if (breakPositions.has(unit.end)) {
        segments.push(segment);
        segment = [];
      }
    }
    if (segment.length > 0) segments.push(segment);

    let current = [];
    for (const candidate of segments) {
      if (unitsWidth(candidate, widthOf) <= limit) {
        if (current.length > 0 && unitsWidth([...current, ...candidate], widthOf) > limit) {
          lines.push(serializeStyledUnits(trimEndSpaces(current)));
          current = trimStartSpaces(candidate);
        } else {
          current.push(...candidate);
        }
        continue;
      }

      if (current.length > 0) {
        lines.push(serializeStyledUnits(trimEndSpaces(current)));
        current = [];
      }
      for (const unit of candidate) {
        if (current.length > 0 && unitsWidth([...current, unit], widthOf) > limit) {
          lines.push(serializeStyledUnits(trimEndSpaces(current)));
          current = isSpace(unit.text) ? [] : [unit];
        } else {
          current.push(unit);
        }
      }
    }
    lines.push(serializeStyledUnits(trimEndSpaces(current)));
  }

  return lines;
}

function parseDiscordStyles(value) {
  let visibleText = '';
  const styles = [];
  let bold = false;
  let underline = false;

  for (let index = 0; index < value.length;) {
    const marker = value.slice(index, index + 2);
    if (marker === '**' && (bold || value.indexOf('**', index + 2) !== -1)) {
      bold = !bold;
      index += 2;
      continue;
    }
    if (marker === '__' && (underline || value.indexOf('__', index + 2) !== -1)) {
      underline = !underline;
      index += 2;
      continue;
    }

    const codePoint = value.codePointAt(index);
    const char = String.fromCodePoint(codePoint);
    for (let offset = 0; offset < char.length; offset += 1) {
      styles[visibleText.length + offset] = { bold, underline };
    }
    visibleText += char;
    index += char.length;
  }
  return { visibleText, styles };
}

function unicodeBreakPositions(value) {
  const positions = new Set();
  const breaker = new LineBreaker(value);
  let next;
  while ((next = breaker.nextBreak())) positions.add(next.position);
  positions.add(value.length);
  return positions;
}

function unitsWidth(units, widthOf) {
  return widthOf(units.map((unit) => unit.text).join(''));
}

function trimStartSpaces(units) {
  let index = 0;
  while (index < units.length && isSpace(units[index].text)) index += 1;
  return units.slice(index);
}

function trimEndSpaces(units) {
  let index = units.length;
  while (index > 0 && isSpace(units[index - 1].text)) index -= 1;
  return units.slice(0, index);
}

function isSpace(value) {
  return /^[ \t]+$/.test(value);
}

function serializeStyledUnits(units) {
  let result = '';
  let index = 0;
  while (index < units.length) {
    const style = units[index];
    let text = '';
    while (index < units.length && units[index].bold === style.bold && units[index].underline === style.underline) {
      text += units[index].text;
      index += 1;
    }
    if (style.underline) text = `__${text}__`;
    if (style.bold) text = `**${text}**`;
    result += text;
  }
  return result;
}
