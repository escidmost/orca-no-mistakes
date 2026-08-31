import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  assertGithubAuthenticationIdentity,
  assertGithubPublicationRouteIdentity,
  GithubAuthority,
  GithubAuthorityError,
  parseGithubRepositoryReference,
  resolveGithubPublicationRoute,
  type CommandRunner,
  type CommandResult
} from '../scripts/github.ts'
import { DomainLedger } from '../scripts/ledger.ts'

const timestamp = '2026-08-31T12:00:00.000Z'
const user = { id: 5, login: 'operator', node_id: 'U_5' }

type ApiHandler = (
  executable: string,
  args: string[],
  options: Parameters<CommandRunner>[2]
) => Promise<CommandResult> | CommandResult

function json(value: unknown): CommandResult {
  return { code: 0, stderr: '', stdout: JSON.stringify(value) }
}

function githubRunner(
  handler: ApiHandler,
  options: { axi?: boolean; calls?: { args: string[]; executable: string; options: Parameters<CommandRunner>[2] }[] } = {}
): CommandRunner {
  return async (executable, args, commandOptions) => {
    options.calls?.push({ args, executable, options: commandOptions })
    if (executable === 'gh' && args[0] === '--version') {
      return { code: 0, stderr: '', stdout: 'gh version 2.97.0\n' }
    }
    if (executable === 'gh-axi' && args[0] === 'api' && args[1] === '--help') {
      return {
        code: 0,
        stderr: '',
        stdout: options.axi ? 'api flags: --hostname --full' : 'api flags: --full'
      }
    }
    if (executable === 'gh-axi' && args[0] === '--version') {
      return { code: 0, stderr: '', stdout: 'gh-axi 1.2.3\n' }
    }
    return handler(executable, args, commandOptions)
  }
}

function repository(input: {
  fork?: boolean
  fullName?: string
  id?: number
  nodeId?: string
  owner?: string
  source?: ReturnType<typeof repositoryBrief>
} = {}) {
  const owner = input.owner ?? 'upstream'
  return {
    default_branch: 'main',
    fork: input.fork ?? false,
    full_name: input.fullName ?? `${owner}/project`,
    id: input.id ?? 10,
    node_id: input.nodeId ?? 'R_10',
    owner: { id: 7, login: owner, node_id: `U_${owner}` },
    source: input.source
  }
}

function repositoryBrief(id = 10, owner = 'upstream') {
  return {
    full_name: `${owner}/project`,
    id,
    node_id: `R_${id}`,
    owner: { id: 7, login: owner, node_id: `U_${owner}` }
  }
}

function pullRequest(input: {
  baseBranch?: string
  headBranch?: string
  headOid?: string
  id: string
  number: number
}) {
  return {
    baseRefName: input.baseBranch ?? 'main',
    baseRefOid: 'a'.repeat(40),
    baseRepository: { databaseId: 10, id: 'R_10', nameWithOwner: 'upstream/project' },
    headRefName: input.headBranch ?? 'feature',
    headRefOid: input.headOid ?? 'b'.repeat(40),
    headRepository: { databaseId: 20, id: 'R_20', nameWithOwner: 'fork/project' },
    id: input.id,
    isDraft: false,
    number: input.number,
    state: 'OPEN',
    url: `https://github.com/upstream/project/pull/${input.number}`
  }
}

test('requires gh and prefers only a hostname-capable gh-axi backend', async () => {
  await assert.rejects(
    () => GithubAuthority.connect({
      runner: async () => ({ code: 127, stderr: '', stdout: '' })
    }),
    (error: unknown) => error instanceof GithubAuthorityError && error.kind === 'prerequisite'
  )

  const calls: { args: string[]; executable: string; options: Parameters<CommandRunner>[2] }[] = []
  const provider = await GithubAuthority.connect({
    env: {
      GH_HOST: 'enterprise.example',
      GH_REPO: 'wrong/repository',
      GH_TOKEN: 'secret-token'
    },
    now: () => new Date(timestamp),
    runner: githubRunner(() => json(user), { axi: true, calls })
  })
  const observation = await provider.observeAuthentication()
  assert.deepEqual(provider.backend(), { kind: 'gh-axi', version: 'gh-axi 1.2.3' })
  assert.equal(observation.credentialSource, 'GH_TOKEN')
  const request = calls.at(-1)!
  assert.equal(request.executable, 'gh-axi')
  assert.deepEqual(request.args.slice(0, 6), ['api', '--hostname', 'github.com', '--full', 'GET', '/user'])
  assert.equal(request.options.env.GH_HOST, undefined)
  assert.equal(request.options.env.GH_REPO, undefined)
  assert.doesNotMatch(JSON.stringify({ observation, args: request.args }), /secret-token|wrong\/repository|enterprise\.example/)
})

test('falls back to gh before authority reads when gh-axi output is malformed', async () => {
  let apiCalls = 0
  const provider = await GithubAuthority.connect({
    runner: githubRunner((executable) => {
      apiCalls += 1
      return executable === 'gh-axi'
        ? { code: 0, stderr: '', stdout: 'not json' }
        : json(user)
    }, { axi: true })
  })
  assert.equal((await provider.observeAuthentication()).actor.id, '5')
  assert.equal(apiCalls, 2)
  assert.deepEqual(provider.backend(), { kind: 'gh', version: 'gh version 2.97.0' })
})

test('safe reads retry bounded transient failures but keep private 404 responses ambiguous', async () => {
  const delays: number[] = []
  let attempts = 0
  const provider = await GithubAuthority.connect({
    runner: githubRunner(() => {
      attempts += 1
      return attempts === 1
        ? { code: 1, stderr: 'HTTP 429 rate limit exceeded', stdout: '' }
        : json(user)
    }),
    sleep: async (delay) => { delays.push(delay) }
  })
  await provider.observeAuthentication()
  assert.equal(attempts, 2)
  assert.deepEqual(delays, [100])

  const hidden = await GithubAuthority.connect({
    runner: githubRunner(() => ({ code: 1, stderr: 'HTTP 404 Not Found', stdout: '' }))
  })
  await assert.rejects(
    () => hidden.observeRepository('private/project'),
    (error: unknown) => error instanceof GithubAuthorityError && error.kind === 'ambiguous'
  )
})

test('GraphQL reads reject partial responses and pagination that does not advance', async () => {
  const partial = await GithubAuthority.connect({
    runner: githubRunner(() => json({
      data: { repository: null },
      errors: [{ message: 'one shard failed' }]
    }))
  })
  await assert.rejects(
    () => partial.observePullRequests({
      baseBranch: 'main',
      baseRepositoryId: '10',
      baseRepositoryName: 'upstream/project',
      baseRepositoryNodeId: 'R_10',
      candidateHeadOid: 'b'.repeat(40),
      headBranch: 'feature',
      headRepositoryId: '20',
      headRepositoryNodeId: 'R_20'
    }),
    (error: unknown) => error instanceof GithubAuthorityError && error.kind === 'malformed'
  )

  let page = 0
  const stuck = await GithubAuthority.connect({
    runner: githubRunner(() => {
      page += 1
      return json({
        data: {
          repository: {
            id: 'R_10',
            pullRequests: {
              nodes: [],
              pageInfo: { endCursor: 'same-cursor', hasNextPage: true }
            }
          }
        }
      })
    })
  })
  await assert.rejects(
    () => stuck.observePullRequests({
      baseBranch: 'main',
      baseRepositoryId: '10',
      baseRepositoryName: 'upstream/project',
      baseRepositoryNodeId: 'R_10',
      candidateHeadOid: 'b'.repeat(40),
      headBranch: 'feature',
      headRepositoryId: '20',
      headRepositoryNodeId: 'R_20'
    }),
    (error: unknown) => error instanceof GithubAuthorityError && error.kind === 'incomplete-pagination'
  )
  assert.equal(page, 2)
})

test('pull request observation is exhaustive, exact, and reports near matches', async () => {
  const pages = [
    {
      nodes: [pullRequest({ id: 'PR_near', number: 1, headBranch: 'other' })],
      pageInfo: { endCursor: 'page-2', hasNextPage: true }
    },
    {
      nodes: [pullRequest({ id: 'PR_exact', number: 2 })],
      pageInfo: { endCursor: null, hasNextPage: false }
    }
  ]
  let page = 0
  const provider = await GithubAuthority.connect({
    runner: githubRunner((_executable, _args, options) => {
      assert.match(options.input ?? '', /states: \[OPEN, CLOSED, MERGED\]/)
      return json({ data: { repository: { id: 'R_10', pullRequests: pages[page++] } } })
    })
  })
  const result = await provider.observePullRequests({
    baseBranch: 'main',
    baseRepositoryId: '10',
    baseRepositoryName: 'upstream/project',
    baseRepositoryNodeId: 'R_10',
    candidateHeadOid: 'b'.repeat(40),
    headBranch: 'feature',
    headRepositoryId: '20',
    headRepositoryNodeId: 'R_20'
  })
  assert.equal(result.exact?.id, 'PR_exact')
  assert.equal(result.exact?.headOid, 'b'.repeat(40))
  assert.equal(result.exact?.state, 'OPEN')
  assert.deepEqual(result.nearMatches.map((item) => item.id), ['PR_near'])
})

test('issue comment observation exhausts every page', async () => {
  const pages = [
    {
      nodes: [{
        author: { id: 'U_5', login: 'operator' },
        body: 'first',
        createdAt: timestamp,
        id: 'IC_1',
        updatedAt: timestamp,
        url: 'https://github.com/upstream/project/pull/1#issuecomment-1'
      }],
      pageInfo: { endCursor: 'page-2', hasNextPage: true }
    },
    {
      nodes: [{
        author: null,
        body: 'second',
        createdAt: timestamp,
        id: 'IC_2',
        updatedAt: timestamp,
        url: 'https://github.com/upstream/project/pull/1#issuecomment-2'
      }],
      pageInfo: { endCursor: null, hasNextPage: false }
    }
  ]
  let page = 0
  const provider = await GithubAuthority.connect({
    runner: githubRunner(() => json({ data: { node: { comments: pages[page++] } } }))
  })
  const comments = await provider.observeIssueComments('PR_1')
  assert.deepEqual(comments.map((comment) => comment.id), ['IC_1', 'IC_2'])
})

test('authentication and route identity checks allow redirects but reject authority drift', () => {
  const authentication = {
    actor: { id: '5', login: 'operator', nodeId: 'U_5' },
    backend: { kind: 'gh' as const, version: '2.97.0' },
    credentialSource: 'stored-account' as const,
    host: 'github.com' as const,
    observedAt: timestamp
  }
  assert.doesNotThrow(() => assertGithubAuthenticationIdentity(authentication, {
    ...authentication,
    actor: { ...authentication.actor, login: 'renamed-operator' }
  }))
  assert.throws(
    () => assertGithubAuthenticationIdentity(authentication, {
      ...authentication,
      actor: { id: '6', login: 'other', nodeId: 'U_6' }
    }),
    (error: unknown) => error instanceof GithubAuthorityError && error.kind === 'identity-drift'
  )

  const route = {
    actorId: '5',
    actorLogin: 'operator',
    actorNodeId: 'U_5',
    backend: 'gh' as const,
    backendVersion: '2.97.0',
    baseBranch: 'main',
    baseRepositoryId: '10',
    baseRepositoryName: 'renamed/project',
    baseRepositoryNodeId: 'R_10',
    credentialSource: 'stored-account' as const,
    forgeHost: 'github.com' as const,
    headBranch: 'feature',
    headOwner: 'fork',
    headRepositoryId: '20',
    headRepositoryName: 'renamed-fork/project',
    headRepositoryNodeId: 'R_20',
    networkRootRepositoryId: '10',
    observedAt: timestamp,
    repoRoot: '/repo'
  }
  const stored = {
    actor_id: '5',
    actor_login: 'operator',
    actor_node_id: 'U_5',
    backend: 'gh' as const,
    backend_version: '2.97.0',
    base_branch: 'main',
    base_repository_id: '10',
    base_repository_name: 'old/project',
    base_repository_node_id: 'R_10',
    credential_source: 'stored-account' as const,
    forge_host: 'github.com' as const,
    head_branch: 'feature',
    head_owner: 'fork',
    head_repository_id: '20',
    head_repository_name: 'old-fork/project',
    head_repository_node_id: 'R_20',
    network_root_repository_id: '10',
    observed_at: timestamp,
    repo_root: '/repo',
    route_fingerprint: 'fingerprint',
    updated_at: timestamp
  }
  assert.doesNotThrow(() => assertGithubPublicationRouteIdentity(stored, route))
  assert.throws(
    () => assertGithubPublicationRouteIdentity(stored, { ...route, headOwner: 'other' }),
    (error: unknown) => error instanceof GithubAuthorityError && error.kind === 'identity-drift'
  )
})

test('route resolution canonicalizes same-repository and fork routes without persisting secrets', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'onm-github-route-'))
  // Git reports the canonical toplevel; the route must key on it, not repoPath.
  const canonicalTemp = await realpath(temp)
  const ledger = new DomainLedger(path.join(temp, 'ledger.sqlite'))
  try {
    let currentUser = user
    const api = await GithubAuthority.connect({
      env: { GITHUB_TOKEN: 'do-not-persist' },
      now: () => new Date(timestamp),
      runner: githubRunner((_executable, args) => {
        if (args.includes('/user')) return json(currentUser)
        if (args.some((arg) => arg.includes('/repos/upstream/project'))) return json(repository())
        return json(repository({
          fork: true,
          fullName: 'fork/project',
          id: 20,
          nodeId: 'R_20',
          owner: 'fork',
          source: repositoryBrief()
        }))
      })
    })
    const git: CommandRunner = async (_executable, args) => ({
      code: 0,
      stderr: '',
      stdout: args.includes('get-url')
        ? 'git@github.com:upstream/project.git\n'
        : args.includes('rev-parse')
          ? `${canonicalTemp}\n`
          : 'feature\n'
    })
    const same = await resolveGithubPublicationRoute({
      commandRunner: git,
      ledger,
      provider: api,
      repoPath: temp
    })
    assert.equal(same.baseRepositoryId, same.headRepositoryId)
    assert.equal(same.baseBranch, 'main')
    assert.equal(same.headBranch, 'feature')
    assert.equal(same.repoRoot, canonicalTemp)

    const fork = await resolveGithubPublicationRoute({
      commandRunner: git,
      fork: 'https://github.com/fork/project.git',
      ledger,
      provider: api,
      repoPath: temp
    })
    assert.equal(fork.baseRepositoryId, '10')
    assert.equal(fork.headRepositoryId, '20')
    assert.equal(fork.networkRootRepositoryId, '10')
    assert.doesNotMatch(JSON.stringify(ledger.repositoryPublicationRoute(canonicalTemp)), /do-not-persist/)
    assert.equal(ledger.repositoryPublicationRoute(canonicalTemp)?.actor_node_id, 'U_5')
    currentUser = { ...user, node_id: 'U_6' }
    await assert.rejects(
      () => resolveGithubPublicationRoute({
        commandRunner: git,
        fork: 'fork/project',
        ledger,
        provider: api,
        repoPath: temp
      }),
      (error: unknown) => error instanceof GithubAuthorityError && error.kind === 'identity-drift'
    )
    currentUser = { ...user, id: 6, node_id: 'U_6' }
    await assert.rejects(
      () => resolveGithubPublicationRoute({
        commandRunner: git,
        fork: 'fork/project',
        ledger,
        provider: api,
        repoPath: temp
      }),
      (error: unknown) => error instanceof GithubAuthorityError && error.kind === 'identity-drift'
    )
  } finally {
    ledger.close()
    await rm(temp, { force: true, recursive: true })
  }
})

test('mutations are single-attempt and return only a reconciliation requirement', async () => {
  let mutations = 0
  const provider = await GithubAuthority.connect({
    runner: githubRunner((_executable, _args, options) => {
      mutations += 1
      const query = JSON.parse(options.input ?? '{}').query as string
      if (query.includes('CreatePullRequest')) {
        return json({ data: { createPullRequest: { pullRequest: { id: 'PR_1' } } } })
      }
      if (query.includes('AddComment')) {
        return json({ data: { addComment: { commentEdge: { node: { id: 'IC_1' } } } } })
      }
      return json({ data: { updateIssueComment: { issueComment: { id: 'IC_1' } } } })
    })
  })
  assert.equal((await provider.createPullRequest({
    baseBranch: 'main',
    baseRepositoryNodeId: 'R_10',
    body: 'body',
    draft: false,
    headRefName: 'fork:feature',
    title: 'title'
  })).requiresReconciliation, true)
  await provider.createIssueComment({ body: 'summary', subjectId: 'PR_1' })
  await provider.updateIssueComment({ body: 'updated', commentId: 'IC_1' })
  assert.equal(mutations, 3)

  let attempted = 0
  const uncertain = await GithubAuthority.connect({
    runner: githubRunner(() => {
      attempted += 1
      return { code: 1, stderr: 'connection reset', stdout: '' }
    })
  })
  await assert.rejects(
    () => uncertain.createIssueComment({ body: 'summary', subjectId: 'PR_1' }),
    (error: unknown) => error instanceof GithubAuthorityError && error.kind === 'mutation-indeterminate'
  )
  assert.equal(attempted, 1)
})

test('repository references accept GitHub forms and reject ambient or credential-bearing URLs', () => {
  assert.deepEqual(parseGithubRepositoryReference('owner/repo'), { owner: 'owner', name: 'repo' })
  assert.deepEqual(parseGithubRepositoryReference('git@github.com:owner/repo.git'), { owner: 'owner', name: 'repo' })
  assert.deepEqual(parseGithubRepositoryReference('ssh://git@github.com/owner/repo.git'), { owner: 'owner', name: 'repo' })
  assert.throws(() => parseGithubRepositoryReference('https://token@github.com/owner/repo'))
  assert.throws(() => parseGithubRepositoryReference('https://enterprise.example/owner/repo'))
  assert.throws(() => parseGithubRepositoryReference('owner/repo/extra'))
})
