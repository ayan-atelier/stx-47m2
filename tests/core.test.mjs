import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSegments, hash, normalizeSettings } from '../src/core.js';
test('core helpers remain deterministic', () => {
  assert.equal(hash('abc'), hash('abc'));
  assert.deepEqual(buildSegments('a\n\nb', 'A\n\nB').map(x => x.id), ['p1','p2']);
  assert.equal(normalizeSettings({ defaultVersion: 'original' }).defaultVersion, 'original');
});
