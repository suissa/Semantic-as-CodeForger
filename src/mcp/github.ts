import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { RepositoryPullRequest, RepositoryReview, RepositoryTarget } from '../shared/types.js';
import { getProjectDirectory, readState, saveState } from './project.js';
import {
  assertRepositoryPublicationFresh,
  compareRepositoryFiles,
  computeRepositoryReviewToken,
  shouldCreatePullRequest
} from './repository-policy.js';

const apiBase = 'https://api.github.com';

interface RepoMetadata { default_branch: string; }
interface RefResponse { object: { sha: string }; }
interface CommitResponse { tree: { sha: string }; }
interface TreeResponse {
  truncated?: boolean;
  tree: Array<{ path?: string; type?: string; sha?: string }>;
}
interface CreateTreeResponse { sha: string; }
interface CreateCommitResponse { sha: string; html_url?: string; }
interface PullRequestResponse {
  number: number;
  html_url: string;
  state: 'open' | 'closed';
  title: string;
  draft?: boolean;
  created_at: string;
  base: { ref: string };
  head: { ref: string };
}

interface LocalFile {
  relativePath: string;
  remotePath: string;
  content: string;
  bytes: number;
  sha: string;
}

function token(): string | undefined {
  return process.env.FORGER_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN;
}

function splitRepository(repository: string): [string, string] {
  const value = repository.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error('repository must use owner/name format');
  }
  return value.split('/') as [string, string];
}

function cleanBranch(value: string): string {
  const branch = value.trim();
  if (!branch || !/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes('..') || branch.endsWith('/') || branch.startsWith('/')) {
    throw new Error(`Invalid Git branch: ${value}`);
  }
  return branch;
}

function cleanPrefix(value: string | undefined): string {
  if (!value) return '';
  const prefix = value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!prefix) return '';
  const segments = prefix.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]+$/.test(segment))) {
    throw new Error(`Invalid repository path prefix: ${value}`);
  }
  return segments.join('/');
}

function cleanPullRequestPolicy(value: string | undefined): RepositoryTarget['pullRequestPolicy'] {
  if (!value || value === 'manual') return 'manual';
  if (value === 'after_publish') return 'after_publish';
  throw new Error(`Invalid pull request policy: ${value}`);
}

function encodeBranch(branch: string): string {
  return branch.split('/').map(encodeURIComponent).join('/');
}

async function rawRequest(target: RepositoryTarget, suffix: string, init: RequestInit = {}): Promise<Response> {
  const [owner, repo] = splitRepository(target.repository);
  const auth = token();
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/vnd.github+json');
  headers.set('x-github-api-version', '2022-11-28');
  headers.set('user-agent', 'semantic-as-code-forger');
  headers.set('content-type', 'application/json');
  if (auth) headers.set('authorization', `Bearer ${auth}`);
  return fetch(`${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`, { ...init, headers });
}

async function jsonRequest<T>(target: RepositoryTarget, suffix: string, init: RequestInit = {}): Promise<T> {
  const response = await rawRequest(target, suffix, init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub ${response.status}: ${body.slice(0, 600)}`);
  }
  return await response.json() as T;
}

async function branchSha(target: RepositoryTarget, branch: string): Promise<string | undefined> {
  const response = await rawRequest(target, `/git/ref/heads/${encodeBranch(branch)}`);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${(await response.text()).slice(0, 600)}`);
  return (await response.json() as RefResponse).object.sha;
}

async function commitTreeSha(target: RepositoryTarget, commitSha: string): Promise<string> {
  const commit = await jsonRequest<CommitResponse>(target, `/git/commits/${encodeURIComponent(commitSha)}`);
  return commit.tree.sha;
}

async function remoteTree(target: RepositoryTarget, treeSha: string): Promise<Map<string, string>> {
  const tree = await jsonRequest<TreeResponse>(target, `/git/trees/${encodeURIComponent(treeSha)}?recursive=1`);
  if (tree.truncated) throw new Error('Remote repository tree is truncated; refusing an incomplete review');
  const output = new Map<string, string>();
  for (const entry of tree.tree) {
    if (entry.type === 'blob' && entry.path && entry.sha) output.set(entry.path, entry.sha);
  }
  return output;
}

function gitBlobSha(content: Buffer): string {
  const header = Buffer.from(`blob ${content.length}\0`);
  return createHash('sha1').update(Buffer.concat([header, content])).digest('hex');
}

async function localFiles(sessionId: string, prefix: string): Promise<LocalFile[]> {
  const root = getProjectDirectory(sessionId);
  const output: LocalFile[] = [];

  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) { await walk(absolute); continue; }
      if (!entry.isFile()) continue;
      const buffer = await readFile(absolute);
      if (buffer.includes(0)) throw new Error(`Binary file is not supported by repository materialization: ${absolute}`);
      const relativePath = relative(root, absolute).replace(/\\/g, '/');
      const remotePath = prefix ? `${prefix}/${relativePath}` : relativePath;
      output.push({
        relativePath,
        remotePath,
        content: buffer.toString('utf8'),
        bytes: buffer.length,
        sha: gitBlobSha(buffer)
      });
    }
  }

  await walk(root);
  return output.sort((a, b) => a.remotePath.localeCompare(b.remotePath));
}

function normalizePullRequest(response: PullRequestResponse, reusedExisting: boolean): RepositoryPullRequest {
  return {
    number: response.number,
    url: response.html_url,
    state: response.state,
    title: response.title,
    baseBranch: response.base.ref,
    headBranch: response.head.ref,
    draft: response.draft === true,
    createdAt: response.created_at,
    reusedExisting
  };
}

async function createPullRequestForState(
  state: Awaited<ReturnType<typeof readState>>,
  input: { title?: string; body?: string; draft?: boolean } = {}
): Promise<RepositoryPullRequest> {
  if (!token()) throw new Error('FORGER_GITHUB_TOKEN or GITHUB_TOKEN is required to create a pull request');
  const target = state.repository?.target;
  const review = state.repository?.review;
  if (!target || !review) throw new Error('Repository review is required before creating a pull request');
  if (!review.publishedAt || !review.commitSha) throw new Error('Publish the reviewed branch before creating a pull request');
  if (review.counts.added + review.counts.modified === 0) throw new Error('There are no reviewed changes to open as a pull request');
  if (target.targetBranch === target.baseBranch) throw new Error('Pull request delivery requires a target branch different from the base branch');

  const currentTarget = await branchSha(target, target.targetBranch);
  if (currentTarget !== review.commitSha) {
    throw new Error('Published target branch moved after publication; refusing to create a stale pull request');
  }

  const [owner] = splitRepository(target.repository);
  const params = new URLSearchParams({
    state: 'open',
    head: `${owner}:${target.targetBranch}`,
    base: target.baseBranch
  });
  const existing = await jsonRequest<PullRequestResponse[]>(target, `/pulls?${params.toString()}`);
  const found = existing[0];
  if (found) {
    const pullRequest = normalizePullRequest(found, true);
    state.repository = { ...state.repository, pullRequest, pullRequestError: undefined };
    await saveState(state);
    return pullRequest;
  }

  const response = await jsonRequest<PullRequestResponse>(target, '/pulls', {
    method: 'POST',
    body: JSON.stringify({
      title: input.title?.trim() || `AllasCode Blueprint: ${state.projectName}`,
      body: input.body?.trim() || `Generated by Semantic-as-Code Forger from a reviewed semantic interview.\n\nReview token: \`${review.token}\`\nBlueprint commit: \`${review.commitSha}\``,
      head: target.targetBranch,
      base: target.baseBranch,
      draft: input.draft ?? target.pullRequestDraft
    })
  });

  const pullRequest = normalizePullRequest(response, false);
  state.repository = { ...state.repository, pullRequest, pullRequestError: undefined };
  await saveState(state);
  return pullRequest;
}

export async function setRepositoryTarget(sessionId: string, input: {
  repository: string;
  baseBranch?: string;
  targetBranch?: string;
  pathPrefix?: string;
  pullRequestPolicy?: string;
  pullRequestDraft?: boolean;
}): Promise<RepositoryTarget> {
  const state = await readState(sessionId);
  const repository = input.repository.trim();
  splitRepository(repository);

  const probeTarget: RepositoryTarget = {
    provider: 'github',
    repository,
    baseBranch: 'main',
    targetBranch: 'main',
    pathPrefix: '',
    pullRequestPolicy: 'manual',
    pullRequestDraft: false,
    configuredAt: new Date().toISOString()
  };
  const metadata = await jsonRequest<RepoMetadata>(probeTarget, '');
  const baseBranch = cleanBranch(input.baseBranch?.trim() || metadata.default_branch);
  probeTarget.baseBranch = baseBranch;
  if (!await branchSha(probeTarget, baseBranch)) throw new Error(`Base branch not found: ${baseBranch}`);

  const target: RepositoryTarget = {
    provider: 'github',
    repository,
    baseBranch,
    targetBranch: cleanBranch(input.targetBranch?.trim() || `forger/${state.projectSlug}-${state.sessionId.slice(0, 8)}`),
    pathPrefix: cleanPrefix(input.pathPrefix),
    pullRequestPolicy: cleanPullRequestPolicy(input.pullRequestPolicy),
    pullRequestDraft: input.pullRequestDraft === true,
    configuredAt: new Date().toISOString()
  };

  state.repository = { target };
  await saveState(state);
  return target;
}

export async function reviewRepository(sessionId: string): Promise<RepositoryReview> {
  const state = await readState(sessionId);
  if (!state.finalizedAt) throw new Error('Finalize the Blueprint before creating a repository review');
  const target = state.repository?.target;
  if (!target) throw new Error('Repository target is not configured');

  const targetHead = await branchSha(target, target.targetBranch);
  const parentBranch = targetHead ? target.targetBranch : target.baseBranch;
  const baseSha = targetHead ?? await branchSha(target, target.baseBranch);
  if (!baseSha) throw new Error(`Base branch not found: ${target.baseBranch}`);
  const baseTreeSha = await commitTreeSha(target, baseSha);
  const remote = await remoteTree(target, baseTreeSha);
  const local = await localFiles(sessionId, target.pathPrefix);
  const compared = compareRepositoryFiles(local, remote);
  const review: RepositoryReview = {
    token: computeRepositoryReviewToken(target, baseSha, local),
    generatedAt: new Date().toISOString(),
    baseSha,
    baseTreeSha,
    parentBranch,
    files: compared.files,
    counts: compared.counts
  };

  state.repository = { target, review };
  await saveState(state);
  return review;
}

export async function publishRepository(sessionId: string, suppliedToken: string): Promise<{
  commitSha: string;
  branch: string;
  repository: string;
  noChanges: boolean;
  pullRequest?: RepositoryPullRequest;
  pullRequestError?: string;
}> {
  const auth = token();
  if (!auth) throw new Error('FORGER_GITHUB_TOKEN or GITHUB_TOKEN is required to publish');
  const state = await readState(sessionId);
  if (!state.finalizedAt) throw new Error('Finalize the Blueprint before publishing');
  const target = state.repository?.target;
  const review = state.repository?.review;
  if (!target || !review) throw new Error('Repository review is required before publishing');
  if (review.token !== suppliedToken) throw new Error('Review token does not match the latest reviewed diff');
  if (review.publishedAt) throw new Error(`This review was already published as ${review.commitSha ?? 'a commit'}`);

  const local = await localFiles(sessionId, target.pathPrefix);
  const currentTarget = await branchSha(target, target.targetBranch);
  const currentBase = currentTarget ? undefined : await branchSha(target, target.baseBranch);
  assertRepositoryPublicationFresh({
    target,
    review,
    currentWorkspaceToken: computeRepositoryReviewToken(target, review.baseSha, local),
    currentTargetSha: currentTarget,
    currentBaseSha: currentBase
  });

  const changed = review.files.filter((file) => file.status !== 'unchanged');
  if (changed.length === 0) {
    review.publishedAt = new Date().toISOString();
    review.commitSha = review.baseSha;
    await saveState(state);
    return { commitSha: review.baseSha, branch: target.targetBranch, repository: target.repository, noChanges: true };
  }

  const localByPath = new Map(local.map((file) => [file.remotePath, file]));
  const tree = await jsonRequest<CreateTreeResponse>(target, '/git/trees', {
    method: 'POST',
    body: JSON.stringify({
      base_tree: review.baseTreeSha,
      tree: changed.map((file) => {
        const localFile = localByPath.get(file.path);
        if (!localFile) throw new Error(`Reviewed file disappeared: ${file.path}`);
        return { path: file.path, mode: '100644', type: 'blob', content: localFile.content };
      })
    })
  });

  const commit = await jsonRequest<CreateCommitResponse>(target, '/git/commits', {
    method: 'POST',
    body: JSON.stringify({
      message: `chore(allascode): forge ${state.projectName} blueprint`,
      tree: tree.sha,
      parents: [review.baseSha]
    })
  });

  if (currentTarget) {
    await jsonRequest(target, `/git/refs/heads/${encodeBranch(target.targetBranch)}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: commit.sha, force: false })
    });
  } else {
    await jsonRequest(target, '/git/refs', {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${target.targetBranch}`, sha: commit.sha })
    });
  }

  review.publishedAt = new Date().toISOString();
  review.commitSha = commit.sha;
  state.repository = { ...state.repository, target, review, pullRequestError: undefined };
  await saveState(state);

  let pullRequest: RepositoryPullRequest | undefined;
  let pullRequestError: string | undefined;
  if (shouldCreatePullRequest(target, review)) {
    try {
      pullRequest = await createPullRequestForState(state);
    } catch (error) {
      pullRequestError = error instanceof Error ? error.message : String(error);
      state.repository = { ...state.repository, pullRequestError };
      await saveState(state);
    }
  }

  return {
    commitSha: commit.sha,
    branch: target.targetBranch,
    repository: target.repository,
    noChanges: false,
    ...(pullRequest ? { pullRequest } : {}),
    ...(pullRequestError ? { pullRequestError } : {})
  };
}

export async function createRepositoryPullRequest(
  sessionId: string,
  input: { title?: string; body?: string; draft?: boolean } = {}
): Promise<RepositoryPullRequest> {
  const state = await readState(sessionId);
  return createPullRequestForState(state, input);
}
