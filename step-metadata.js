/**
 * STEP (ISO 10303-21) header reader.
 *
 * A STEP file opens with a plain-text HEADER section that records who exported the
 * model and from what. That is the one piece of information a STEP file carries which
 * cannot be recovered from its geometry, so it is worth reading even though the rest
 * of the file only becomes useful after tessellation.
 *
 *   FILE_NAME('Loop Head','2026-07-19T01:19:41Z',('A Designer'),('A Studio'),
 *             'ST-DEVELOPER v20','ONSHAPE BY PTC INC, 1.218','none');
 *
 * No Electron or database imports here so it can be unit-tested with plain Node.
 */

/** The header is ASCII and always short; never read the whole solid to find it. */
const HEADER_READ_BYTES = 64 * 1024;

/**
 * Values exporters write when they have nothing to say. Treating these as real would
 * file models under a designer called "Unknown" or name every part after its exporter.
 */
const PLACEHOLDER_VALUES = new Set([
  '', 'unknown', 'none', 'n/a', 'na', 'null', 'undefined', 'nobody', 'no author',
  'open cascade shape model', 'shape model', 'untitled', 'unnamed', 'default'
]);

function isMeaningful(value) {
  if (value == null) return false;
  const trimmed = String(value).trim();
  if (!trimmed) return false;
  return !PLACEHOLDER_VALUES.has(trimmed.toLowerCase());
}

/**
 * Decode a STEP string literal: '' is an escaped quote, and \X2\..\X0\ /  \X\hh
 * carry characters outside the base character set.
 */
function decodeStepString(raw) {
  let text = String(raw == null ? '' : raw).replace(/''/g, "'");
  text = text.replace(/\\X2\\([0-9A-Fa-f]+)\\X0\\/g, (_m, hex) => {
    let out = '';
    for (let i = 0; i + 3 < hex.length + 1; i += 4) {
      const code = parseInt(hex.slice(i, i + 4), 16);
      if (Number.isFinite(code)) out += String.fromCharCode(code);
    }
    return out;
  });
  text = text.replace(/\\X\\([0-9A-Fa-f]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
  text = text.replace(/\\S\\(.)/g, (_m, ch) => ch);
  return text.trim();
}

/**
 * Split a STEP parameter list on top-level commas, ignoring commas inside quotes or
 * nested parentheses. Entity parameters are positional, so the split has to be exact.
 */
function splitStepParameters(text) {
  const parts = [];
  let current = '';
  let depth = 0;
  let inString = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === "'") {
        if (text[i + 1] === "'") {
          current += "''";
          i++;
          continue;
        }
        inString = false;
      }
      current += char;
      continue;
    }
    if (char === "'") {
      inString = true;
      current += char;
      continue;
    }
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

/** A STEP parameter is either a quoted string, a parenthesised list of them, or `$`. */
function readStepValue(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text || text === '$' || text === '*') return [];
  if (text.startsWith('(')) {
    const inner = text.slice(1, text.endsWith(')') ? -1 : undefined);
    return splitStepParameters(inner).flatMap(readStepValue);
  }
  if (text.startsWith("'")) {
    const closing = text.endsWith("'") ? -1 : undefined;
    return [decodeStepString(text.slice(1, closing))];
  }
  return [];
}

/** Pull one entity's parameter text out of the header, tolerating line wrapping. */
function findHeaderEntity(headerText, entityName) {
  const start = headerText.toUpperCase().indexOf(entityName.toUpperCase() + '(');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  for (let i = start + entityName.length; i < headerText.length; i++) {
    const char = headerText[i];
    if (inString) {
      if (char === "'") {
        if (headerText[i + 1] === "'") { i++; continue; }
        inString = false;
      }
      continue;
    }
    if (char === "'") { inString = true; continue; }
    if (char === '(') depth++;
    else if (char === ')') {
      depth--;
      if (depth === 0) {
        return headerText.slice(start + entityName.length + 1, i);
      }
    }
  }
  return null;
}

/** STEP allows /* … *​/ comments between parameters; Onshape uses them to label fields. */
function stripStepComments(text) {
  return String(text || '').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * Parse the HEADER section of a STEP file.
 * Returns nulls rather than placeholder text for anything the exporter left blank.
 */
function parseStepHeader(text) {
  const result = {
    name: null,
    author: null,
    organization: null,
    originatingSystem: null,
    preprocessor: null,
    description: null,
    timestamp: null
  };
  if (!text) return result;

  const endsec = text.toUpperCase().indexOf('ENDSEC;');
  const headerText = stripStepComments(endsec === -1 ? text : text.slice(0, endsec));

  const fileName = findHeaderEntity(headerText, 'FILE_NAME');
  if (fileName) {
    const params = splitStepParameters(fileName);
    const name = readStepValue(params[0])[0];
    const timestamp = readStepValue(params[1])[0];
    const authors = readStepValue(params[2]).filter(isMeaningful);
    const organizations = readStepValue(params[3]).filter(isMeaningful);
    const preprocessor = readStepValue(params[4])[0];
    const originating = readStepValue(params[5])[0];

    if (isMeaningful(name)) result.name = name;
    if (timestamp) result.timestamp = timestamp;
    if (authors.length) result.author = authors.join(', ');
    if (organizations.length) result.organization = organizations.join(', ');
    if (isMeaningful(preprocessor)) result.preprocessor = preprocessor;
    if (isMeaningful(originating)) result.originatingSystem = originating;
  }

  const description = findHeaderEntity(headerText, 'FILE_DESCRIPTION');
  if (description) {
    const params = splitStepParameters(description);
    const texts = readStepValue(params[0]).filter(isMeaningful);
    if (texts.length) result.description = texts.join(' ');
  }

  return result;
}

/**
 * Map a STEP header onto the fields Printventory stores.
 *
 * Only the designer is taken. A STEP file's internal name is usually the CAD
 * document's own label ("Part Studio 1 - Part 1"), which says less than the file name
 * the user downloaded, so it is deliberately not used to rename anything.
 */
function stepMetadataToModelFields(header) {
  const fields = { designer: null, notes: null };
  if (!header) return fields;
  const designer = isMeaningful(header.author)
    ? header.author
    : (isMeaningful(header.organization) ? header.organization : null);
  if (designer) fields.designer = designer;
  return fields;
}

/** Read just enough of a file to parse its header. `readChunk` keeps this fs-free. */
async function extractStepMetadata(filePath, readChunk) {
  if (typeof readChunk !== 'function') throw new Error('extractStepMetadata needs a chunk reader');
  const buffer = await readChunk(filePath, HEADER_READ_BYTES);
  if (!buffer) return null;
  const text = Buffer.isBuffer(buffer) ? buffer.toString('latin1') : String(buffer);
  if (!/ISO-10303-21/i.test(text)) return null;
  return parseStepHeader(text);
}

module.exports = {
  HEADER_READ_BYTES,
  isMeaningful,
  decodeStepString,
  splitStepParameters,
  readStepValue,
  stripStepComments,
  parseStepHeader,
  stepMetadataToModelFields,
  extractStepMetadata
};
