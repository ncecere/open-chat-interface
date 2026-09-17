// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Direct Actions script, never a cached Turbo task.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const stableTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function assertStableTag(tag) {
  if (!stableTag.test(tag ?? '')) throw new Error('Expected a stable release tag: vX.Y.Z');
  return tag;
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function resolveReleaseTarget(tag, repository, cwd = process.cwd()) {
  assertStableTag(tag);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw new Error('Expected owner/repository');
  const sha = git(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], cwd);
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Expected a full commit SHA');
  git(['merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main'], cwd);
  return {
    tag,
    sha,
    short_sha: sha.slice(0, 8),
    image_root: `ghcr.io/${repository.toLowerCase()}`,
    created: git(['show', '-s', '--format=%cI', sha], cwd),
  };
}

export function newestStableTag(tags) {
  return tags
    .filter((tag) => stableTag.test(tag))
    .sort((a, b) => {
      const left = a.slice(1).split('.').map(BigInt);
      const right = b.slice(1).split('.').map(BigInt);
      for (let i = 0; i < 3; i++) {
        if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
      }
      return 0;
    })
    .at(-1);
}

export function isNewestRelease(tag, cwd = process.cwd()) {
  assertStableTag(tag);
  const tags = git(['tag', '--merged', 'refs/remotes/origin/main'], cwd).split('\n');
  return tag === newestStableTag(tags);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tag = process.env.RELEASE_TAG;
  const values =
    process.argv[2] === 'latest'
      ? { promote: String(isNewestRelease(tag)) }
      : resolveReleaseTarget(tag, process.env.GITHUB_REPOSITORY);
  const output = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  console.log(output);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${output}\n`);
}
