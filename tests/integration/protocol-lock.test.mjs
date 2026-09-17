import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { validateLock } from '../../scripts/check-protocol.mjs';

const lock = JSON.parse(readFileSync(new URL('../../protocol-lock.json', import.meta.url), 'utf8'));
test('protocol source lock is explicit and portable', () => {
  validateLock(lock);
  assert.equal(lock.protocolVersion, '1.11.8');
  assert.equal(lock.commit, '1ed830aa0d696b52dbd666118ced475f4d6e8f79');
});
test('protocol lock rejects ambiguous paths, duplicate files and unpinned source', () => {
  for (const path of ['../outside', '/absolute', 'a/../b', 'C:\\external', './VERSION']) {
    assert.throws(() => validateLock({ ...lock, files: [{ path, sha256: 'a'.repeat(64) }] }));
  }
  assert.throws(() => validateLock({ ...lock, commit: 'main' }));
  assert.throws(() => validateLock({ ...lock, files: [...lock.files, lock.files[0]] }));
});
