import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSegments, extractText, normalizeApiUrl, splitParagraphs } from '../src/core.js';

test('normalizes compatible API URLs', () => {
  assert.equal(normalizeApiUrl('https://example.com/v1/chat/completions'), 'https://example.com/v1');
  assert.equal(normalizeApiUrl('https://example.com/v1/'), 'https://example.com/v1');
});

test('splits and aligns paragraphs without losing order', () => {
  assert.deepEqual(splitParagraphs(' a\n\n b\r\n\r\n c '), ['a', 'b', 'c']);
  assert.deepEqual(buildSegments('a\n\nb', 'A\n\nB'), [
    { id:'p1', original:'a', revised:'A' }, { id:'p2', original:'b', revised:'B' },
  ]);
});

test('accepts plain and JSON correction responses', () => {
  assert.equal(extractText({ choices:[{ message:{ content:'  revised  ' } }] }), 'revised');
  assert.equal(extractText({ choices:[{ message:{ content:'{"revised":"new text"}' } }] }), 'new text');
});
