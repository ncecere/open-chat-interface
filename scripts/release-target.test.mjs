import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assertStableTag,
  isNewestRelease,
  newestStableTag,
  resolveReleaseTarget,
} from './release-target.mjs';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'oci-release-ref-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Release test');
  git('config', 'user.email', 'release@example.test');
  git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Release');
  git('tag', 'v0.4.1');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  return { cwd, git };
}

test('accepts only stable, canonical tags before invoking git', () => {
  assert.equal(assertStableTag('v0.4.1'), 'v0.4.1');
  for (const tag of [
    '',
    undefined,
    'main',
    'v1.0.0-beta',
    'v01.0.0',
    'v1.0.0\nother=value',
    '--help',
    'v1.0.0;echo hi',
  ]) {
    assert.throws(() => assertStableTag(tag));
  }
});

test('resolves an immutable tag, lowercases the image path and permits historical releases on main', (t) => {
  const { cwd, git } = fixture(t);
  const sha = git('rev-parse', 'HEAD');
  git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Workflow added later');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  assert.deepEqual(resolveReleaseTarget('v0.4.1', 'Owner/Repo', cwd), {
    tag: 'v0.4.1',
    sha,
    short_sha: sha.slice(0, 8),
    image_root: 'ghcr.io/owner/repo',
    created: git('show', '-s', '--format=%cI', sha),
  });
});

test('rejects missing tags, non-main commits and malformed repository names', (t) => {
  const { cwd, git } = fixture(t);
  assert.throws(() => resolveReleaseTarget('v9.0.0', 'owner/repo', cwd));
  assert.throws(() => resolveReleaseTarget('v0.4.1', 'owner/repo\nimage=bad', cwd));
  git('checkout', '-b', 'unreviewed');
  git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Unreviewed');
  git('tag', 'v9.0.0');
  assert.throws(() => resolveReleaseTarget('v9.0.0', 'owner/repo', cwd));
});

test('latest uses semantic numeric ordering and ignores prereleases/non-main tags', (t) => {
  assert.equal(newestStableTag(['v0.4.9', 'v0.4.10', 'v2.0.0-rc.1', 'other']), 'v0.4.10');
  const { cwd, git } = fixture(t);
  git('tag', 'v0.4.2');
  assert.equal(isNewestRelease('v0.4.1', cwd), false);
  assert.equal(isNewestRelease('v0.4.2', cwd), true);
  git('checkout', '-b', 'other');
  git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Not on main');
  git('tag', 'v9.0.0');
  assert.equal(isNewestRelease('v0.4.2', cwd), true);
});
