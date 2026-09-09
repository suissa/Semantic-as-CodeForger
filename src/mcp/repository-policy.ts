import { createHash } from 'node:crypto';
import type { RepositoryReview, RepositoryReviewFile, RepositoryTarget } from '../shared/types.js';

export interface RepositoryLocalFileDigest {
  remotePath: string;
  bytes: number;
  sha: string;
}

export function computeRepositoryReviewToken(
  target: Pick<RepositoryTarget, 'repository' | 'targetBranch' | 'pathPrefix'>,
  baseSha: string,
  files: Array<Pick<RepositoryLocalFileDigest, 'remotePath' | 'sha'>>
): string {
  const normalized = [...files]
    .sort((a, b) => a.remotePath.localeCompare(b.remotePath))
    .map((file) => [file.remotePath, file.sha]);

  return createHash('sha256').update(JSON.stringify({
    repository: target.repository,
    targetBranch: target.targetBranch,
    pathPrefix: target.pathPrefix,
    baseSha,
    files: normalized
  })).digest('hex');
}

export function compareRepositoryFiles(
  local: RepositoryLocalFileDigest[],
  remote: ReadonlyMap<string, string>
): { files: RepositoryReviewFile[]; counts: RepositoryReview['counts'] } {
  const files: RepositoryReviewFile[] = [...local]
    .sort((a, b) => a.remotePath.localeCompare(b.remotePath))
    .map((file) => {
      const remoteSha = remote.get(file.remotePath);
      return {
        path: file.remotePath,
        status: !remoteSha ? 'added' : remoteSha === file.sha ? 'unchanged' : 'modified',
        bytes: file.bytes,
        sha: file.sha,
        ...(remoteSha ? { remoteSha } : {})
      };
    });

  return {
    files,
    counts: {
      added: files.filter((file) => file.status === 'added').length,
      modified: files.filter((file) => file.status === 'modified').length,
      unchanged: files.filter((file) => file.status === 'unchanged').length
    }
  };
}

export function assertRepositoryPublicationFresh(input: {
  target: RepositoryTarget;
  review: RepositoryReview;
  currentWorkspaceToken: string;
  currentTargetSha?: string;
  currentBaseSha?: string;
}): void {
  const { target, review, currentWorkspaceToken, currentTargetSha, currentBaseSha } = input;

  if (currentWorkspaceToken !== review.token) {
    throw new Error('Workspace changed after review; generate a new repository review');
  }

  if (currentTargetSha) {
    if (currentTargetSha !== review.baseSha || review.parentBranch !== target.targetBranch) {
      throw new Error('Target branch changed after review; generate a new repository review');
    }
    return;
  }

  if (currentBaseSha !== review.baseSha || review.parentBranch !== target.baseBranch) {
    throw new Error('Base branch changed after review; generate a new repository review');
  }
}

export function shouldCreatePullRequest(target: RepositoryTarget, review: RepositoryReview): boolean {
  return target.pullRequestPolicy === 'after_publish'
    && target.targetBranch !== target.baseBranch
    && review.counts.added + review.counts.modified > 0
    && Boolean(review.publishedAt && review.commitSha);
}
