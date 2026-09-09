import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { RepositoryReview, RepositoryReviewFile, RepositoryTarget } from '../shared/types.js';
import { getProjectDirectory, readState, saveState } from './project.js';

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

function reviewToken(target: RepositoryTarget, baseSha: string, files: Array<{ remotePath: string; sha: string }>): string {
  return createHash('sha256').update(JSON.stringify({
    repository: target.repository,
    targetBranch: target.targetBranch,
    pathPrefix: target.pathPrefix,
    baseSha,
    files: files.map((file) => [file.remotePath, file.sha])
  })).digest('hex');
}

export async function setRepositoryTarget(sessionId: string, input: {
  repository: string;
  baseBranch?: string;
  targetBranch?: string;
  pathPrefix?: string;
}): Promise<RepositoryTarget> {
  const state = await readState(sessionId);
  const repository = input.repository.trim();
  splitRepository(repository);

  const probeTarget: RepositoryTarget = {
    provider: 'github', repository, baseBranch: 'main', targetBranch: 'main', pathPrefix: '', configuredAt: new Date().toISOString()
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

  const files: RepositoryReviewFile[] = local.map((file) => {
    const remoteSha = remote.get(file.remotePath);
    return {
      path: file.remotePath,
      status: !remoteSha ? 'added' : remoteSha === file.sha ? 'unchanged' : 'modified',
      bytes: file.bytes,
      sha: file.sha,
      ...(remoteSha ? { remoteSha } : {})
    };
  });
  const counts = {
    added: files.filter((file) => file.status === 'added').length,
    modified: files.filter((file) => file.status === 'modified').length,
    unchanged: files.filter((file) => file.status === 'unchanged').length
  };
  const review: RepositoryReview = {
    token: reviewToken(target, baseSha, local),
    generatedAt: new Date().toISOString(),
    baseSha,
    baseTreeSha,
    parentBranch,
    files,
    counts
  };

  state.repository = { target, review };
  await saveState(state);
  return review;
}

export async function publishRepository(sessionId: string, suppliedToken: string): Promise<{ commitSha: string; branch: string; repository: string; noChanges: boolean }> {
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
  if (reviewToken(target, review.baseSha, local) !== review.token) {
    throw new Error('Workspace changed after review; generate a new repository review');
  }

  const currentTarget = await branchSha(target, target.targetBranch);
  if (currentTarget) {
    if (currentTarget !== review.baseSha || review.parentBranch !== target.targetBranch) {
      throw new Error('Target branch changed after review; generate a new repository review');
    }
  } else {
    const currentBase = await branchSha(target, target.baseBranch);
    if (currentBase !== review.baseSha || review.parentBranch !== target.baseBranch) {
      throw new Error('Base branch changed after review; generate a new repository review');
    }
  }

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
  await saveState(state);
  return { commitSha: commit.sha, branch: target.targetBranch, repository: target.repository, noChanges: false };
}
