#!/usr/bin/env node
'use strict';

/**
 * Plain-Node tests for the STEP header reader.
 * Run with: npm run test:step
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  isMeaningful,
  decodeStepString,
  splitStepParameters,
  readStepValue,
  stripStepComments,
  parseStepHeader,
  stepMetadataToModelFields,
  extractStepMetadata
} = require('./step-metadata');

const pending = [];
function test(name, fn) {
  pending.push({ name, fn });
}

async function runAll() {
  for (const { name, fn } of pending) {
    try {
      await fn();
      console.log(`ok ${name}`);
    } catch (err) {
      console.error(`FAIL ${name}:`, err.message);
      process.exitCode = 1;
    }
  }
}

test('isMeaningful rejects the values exporters write for "nothing"', () => {
  assert.strictEqual(isMeaningful('CinderWing3D'), true);
  assert.strictEqual(isMeaningful(''), false);
  assert.strictEqual(isMeaningful('  '), false);
  assert.strictEqual(isMeaningful('Unknown'), false);
  assert.strictEqual(isMeaningful('none'), false);
  assert.strictEqual(isMeaningful('Open CASCADE Shape Model'), false);
  assert.strictEqual(isMeaningful(null), false);
});

test('decodeStepString unescapes quotes and encoded characters', () => {
  assert.strictEqual(decodeStepString("Bob''s Parts"), "Bob's Parts");
  assert.strictEqual(decodeStepString('\\X2\\00E9\\X0\\clair'), 'éclair');
  assert.strictEqual(decodeStepString('caf\\X\\E9'), 'café');
});

test('splitStepParameters ignores commas inside strings and lists', () => {
  const parts = splitStepParameters("'a,b',('c','d'),'e'");
  assert.deepStrictEqual(parts, ["'a,b'", "('c','d')", "'e'"]);
});

test('readStepValue handles strings, lists and unset markers', () => {
  assert.deepStrictEqual(readStepValue("'Studio'"), ['Studio']);
  assert.deepStrictEqual(readStepValue("('One','Two')"), ['One', 'Two']);
  assert.deepStrictEqual(readStepValue('$'), []);
  assert.deepStrictEqual(readStepValue(''), []);
});

test('stripStepComments removes the field labels some exporters emit', () => {
  const stripped = stripStepComments("/* name */ 'Part', /* author */ ('Bob')");
  assert.ok(!stripped.includes('/*'));
  assert.ok(stripped.includes("'Part'"));
  assert.ok(stripped.includes("'Bob'"));
});

test('parses a header that wraps across lines', () => {
  const text = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('FreeCAD Model'),'2;1');
FILE_NAME('Open CASCADE Shape Model','2026-08-26T04:06:36',('A Designer'),(
    'A Studio'),'Open CASCADE STEP processor 7.8','FreeCAD','Unknown');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));
ENDSEC;
DATA;
#1 = APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#2);
ENDSEC;
END-ISO-10303-21;`;
  const header = parseStepHeader(text);
  assert.strictEqual(header.author, 'A Designer');
  assert.strictEqual(header.organization, 'A Studio');
  assert.strictEqual(header.originatingSystem, 'FreeCAD');
  assert.strictEqual(header.description, 'FreeCAD Model');
  assert.strictEqual(header.timestamp, '2026-08-26T04:06:36');
  // The generic name OpenCascade writes must not be mistaken for a real title.
  assert.strictEqual(header.name, null);
});

test('parses an Onshape header, comments and all', () => {
  const text = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('STEP AP242'),'2;1');
FILE_NAME( /* name */ 'Loop Head - Loop Head', /* time_stamp */ '2026-07-19T01:19:41Z',
  /* author */ (''), /* organization */ (''),
  /* preprocessor_version */ 'ST-DEVELOPER v20',
  /* originating_system */ 'ONSHAPE BY PTC INC, 1.218', /* authorisation */ '  ');
ENDSEC;
DATA;
ENDSEC;
END-ISO-10303-21;`;
  const header = parseStepHeader(text);
  assert.strictEqual(header.name, 'Loop Head - Loop Head');
  assert.strictEqual(header.author, null, 'empty author must not become a designer');
  assert.strictEqual(header.organization, null);
  assert.strictEqual(header.originatingSystem, 'ONSHAPE BY PTC INC, 1.218');
});

test('several authors collapse to one designer string', () => {
  const text = `ISO-10303-21;
HEADER;
FILE_NAME('Part','2026-01-01T00:00:00',('Ada','Grace'),('','ACME'),'pp','sys','none');
ENDSEC;`;
  const header = parseStepHeader(text);
  assert.strictEqual(header.author, 'Ada, Grace');
  assert.strictEqual(header.organization, 'ACME');
});

test('a header with no FILE_NAME yields nothing rather than throwing', () => {
  const header = parseStepHeader('ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;');
  assert.strictEqual(header.author, null);
  assert.strictEqual(header.name, null);
  assert.deepStrictEqual(stepMetadataToModelFields(header), { designer: null, notes: null });
});

test('stepMetadataToModelFields prefers the author, then the organization', () => {
  assert.strictEqual(stepMetadataToModelFields({ author: 'Ada', organization: 'ACME' }).designer, 'Ada');
  assert.strictEqual(stepMetadataToModelFields({ author: null, organization: 'ACME' }).designer, 'ACME');
  assert.strictEqual(stepMetadataToModelFields({ author: null, organization: null }).designer, null);
  assert.strictEqual(stepMetadataToModelFields(null).designer, null);
});

test('extractStepMetadata reads the bundled STEP fixture', async () => {
  const fixture = path.join(__dirname, 'tests', 'test-fixtures', 'scan-me', 'cube.step');
  assert.ok(fs.existsSync(fixture), 'cube.step fixture should exist');
  const readChunk = async (filePath, bytes) => {
    const handle = await fs.promises.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  };
  const header = await extractStepMetadata(fixture, readChunk);
  assert.ok(header, 'fixture should parse as STEP');
  assert.strictEqual(stepMetadataToModelFields(header).designer, 'Printventory Tests');
});

test('a file that is not STEP returns null', async () => {
  const readChunk = async () => Buffer.from('solid cube\nendsolid cube\n');
  assert.strictEqual(await extractStepMetadata('whatever.stl', readChunk), null);
});

runAll();
