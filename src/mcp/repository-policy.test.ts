import assert from 'node:assert/strict';
import test from 'node:test';
import type { RepositoryReview, RepositoryTarget } from '../shared/types.js';
import {
  assertRepositoryPublicationFresh,
  compareRepositoryFiles,
  computeRepositoryReviewToken,
  shouldCreatePullRequest
} from './repository-policy.js';

const target: RepositoryTarget = {
  provider: 'github',
  repository: 'acme/example',
  baseBranch: 'main',
  targetBranch: 'forger/demo',
  pathPrefix: 'Blueprint',
  pullRequestPolicy: 'manual',
  pullRequestDraft: false,
  configuredAt: '2026-09-09T00:00:00.000Z'
};

function review(overrides: Partial<RepositoryReview> = {}): RepositoryReview {
  return {
    token: 'review-token',
    generatedAt: '2026-09-09T00:00:00.000Z',
    baseSha: 'base-sha',
    baseTreeSha: 'tree-sha',
    parentBranch: 'main',
    files: [],
    counts: { added: 1, modified: 0, unchanged: 0 },
    ...overrides
  };
}

test('classifies added, modified and unchanged files deterministically', () => {
  const result = compareRepositoryFiles([
    { remotePath: 'b.yml', bytes: 2, sha: 'same' },
    { remotePath: 'a.yml', bytes: 1, sha: 'new' },
    { remotePath: 'c.yml', bytes: 3, sha: 'local' }
  ], new Map([
    ['b.yml', 'same'],
    ['c.yml', 'remote']
  ]));

  assert.deepEqual(result.files.map((file) => [file.path, file.status]), [
    ['a.yml', 'added'],
    ['b.yml', 'unchanged'],
    ['c.yml', 'modified']
  ]);
  assert.deepEqual(result.counts, { added: 1, modified: 1, unchanged: 1 });
});

test('review token is independent from local iteration order', () => {
  const first = computeRepositoryReviewToken(target, 'abc', [
    { remotePath: 'b', sha: '2' },
    { remotePath: 'a', sha: '1' }
  ]);
  const second = computeRepositoryReviewToken(target, 'abc', [
    { remotePath: 'a', sha: '1' },
    { remotePath: 'b', sha: '2' }
  ]);
  assert.equal(first, second);
});

test('rejects workspace mutation after review', () => {
  assert.throws(() => assertRepositoryPublicationFresh({
    target,
    review: review(),
    currentWorkspaceToken: 'different',
    currentBaseSha: 'base-sha'
  }), /Workspace changed after review/);
});

test('rejects base branch movement while review was based on base', () => {
  assert.throws(() => assertRepositoryPublicationFresh({
    target,
    review: review(),
    currentWorkspaceToken: 'review-token',
    currentBaseSha: 'new-base'
  }), /Base branch changed after review/);
});

test('rejects target branch appearing after a base-branch review', () => {
  assert.throws(() => assertRepositoryPublicationFresh({
    target,
    review: review(),
    currentWorkspaceToken: 'review-token',
    currentTargetSha: 'base-sha'
  }), /Target branch changed after review/);
});

test('accepts unchanged target branch when the review was based on target', () => {
  assert.doesNotThrow(() => assertRepositoryPublicationFresh({
    target,
    review: review({ parentBranch: target.targetBranch }),
    currentWorkspaceToken: 'review-token',
    currentTargetSha: 'base-sha'
  }));
});

test('auto PR policy requires published non-empty diff and separate branches', () => {
  const autoTarget = { ...target, pullRequestPolicy: 'after_publish' as const };
  assert.equal(shouldCreatePullRequest(autoTarget, review({ publishedAt: 'now', commitSha: 'commit' })), true);
  assert.equal(shouldCreatePullRequest(autoTarget, review({ publishedAt: 'now', commitSha: 'commit', counts: { added: 0, modified: 0, unchanged: 4 } })), false);
  assert.equal(shouldCreatePullRequest({ ...autoTarget, targetBranch: 'main' }, review({ publishedAt: 'now', commitSha: 'commit' })), false);
});
