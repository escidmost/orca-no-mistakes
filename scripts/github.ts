import { spawn } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { z } from 'zod'

import type {
  DomainLedger,
  RepositoryPublicationRouteInput,
  RepositoryPublicationRouteRow
} from './ledger.ts'

export const GITHUB_HOST = 'github.com' as const

export const GithubAuthorityFailureSchema = z.enum([
  'prerequisite',
  'authentication',
  'authorization',
  'rate-limit',
  'unavailable',
  'malformed',
  'incomplete-pagination',
  'identity-drift',
  'ambiguous',
  'mutation-indeterminate'
])
export type GithubAuthorityFailure = z.infer<typeof GithubAuthorityFailureSchema>

export class GithubAuthorityError extends Error {
  readonly kind: GithubAuthorityFailure
  readonly operation: string

  constructor(
    kind: GithubAuthorityFailure,
    operation: string,
    message: string
  ) {
    super(message)
    this.kind = kind
    this.operation = operation
    this.name = 'GithubAuthorityError'
  }
}

export type CommandResult = {
  code: number
  stderr: string
  stdout: string
}

export type CommandRunner = (
  executable: string,
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; input?: string }
) => Promise<CommandResult>

const COMMAND_TIMEOUT_MS = 120_000

export const runCommand: CommandRunner = (executable, args, options) => new Promise((resolve) => {
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: COMMAND_TIMEOUT_MS
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  child.on('error', (error) => {
    const timedOut = (error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
    // Timeout and signal kills surface as the retryable `unavailable` class.
    resolve({ code: timedOut ? 124 : 127, stderr: timedOut ? 'command timed out' : 'command unavailable', stdout: '' })
  })
  child.on('close', (code, signal) => resolve({
    code: code ?? (signal ? 124 : 1),
    stderr: code === null && signal ? `terminated by ${signal}` : stderr,
    stdout
  }))
  // ponytail: a child that closes stdin early must not crash the coordinator
  // with an uncaught EPIPE; the classified close result carries the failure.
  child.stdin.on('error', () => {})
  child.stdin.end(options.input)
})

const NumericIdSchema = z.union([
  z.string().min(1),
  z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
]).transform(String)

const NodeIdSchema = z.string().min(1)
const NameWithOwnerSchema = z.string().regex(/^[^/\s]+\/[^/\s]+$/)
const RefSchema = z.string().min(1)
const OidSchema = z.string().regex(/^[0-9a-f]{40,64}$/i)

const ActorSchema = z.object({
  id: NumericIdSchema,
  login: z.string().min(1),
  node_id: NodeIdSchema
})

const RepositoryBriefSchema = z.object({
  full_name: NameWithOwnerSchema,
  id: NumericIdSchema,
  node_id: NodeIdSchema,
  owner: ActorSchema
})

const RepositorySchema = RepositoryBriefSchema.extend({
  default_branch: RefSchema,
  fork: z.boolean(),
  parent: RepositoryBriefSchema.nullish(),
  source: RepositoryBriefSchema.nullish()
})

const GraphqlErrorSchema = z.object({ message: z.string().min(1) })
const GraphqlEnvelopeSchema = z.object({
  data: z.unknown().optional(),
  errors: z.array(GraphqlErrorSchema).min(1).optional()
})
const PageInfoSchema = z.object({
  endCursor: z.string().min(1).nullable(),
  hasNextPage: z.boolean()
})
const GraphqlRepositorySchema = z.object({
  databaseId: NumericIdSchema,
  id: NodeIdSchema,
  nameWithOwner: NameWithOwnerSchema
})
const PullRequestNodeSchema = z.object({
  body: z.string(),
  baseRefName: RefSchema,
  baseRefOid: OidSchema,
  baseRepository: GraphqlRepositorySchema,
  headRefName: RefSchema,
  headRefOid: OidSchema.nullable(),
  headRepository: GraphqlRepositorySchema.nullable(),
  id: NodeIdSchema,
  isDraft: z.boolean(),
  number: z.number().int().positive(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  title: z.string().min(1),
  url: z.string().url()
})
const PullRequestPageSchema = z.object({
  repository: z.object({
    id: NodeIdSchema,
    pullRequests: z.object({
      nodes: z.array(PullRequestNodeSchema),
      pageInfo: PageInfoSchema
    })
  }).nullable()
})
const CommentNodeSchema = z.object({
  author: z.object({ id: NodeIdSchema, login: z.string().min(1) }).nullable(),
  body: z.string(),
  createdAt: z.string().datetime(),
  id: NodeIdSchema,
  updatedAt: z.string().datetime(),
  url: z.string().url()
})
const CommentPageSchema = z.object({
  node: z.object({
    comments: z.object({
      nodes: z.array(CommentNodeSchema),
      pageInfo: PageInfoSchema
    })
  }).nullable()
})
const CheckContextSchema = z.discriminatedUnion('__typename', [
  z.object({
    __typename: z.literal('CheckRun'),
    conclusion: z.string().nullable(),
    detailsUrl: z.string().nullable(),
    name: z.string(),
    status: z.string()
  }),
  z.object({
    __typename: z.literal('StatusContext'),
    context: z.string(),
    state: z.string(),
    targetUrl: z.string().nullable()
  })
])
const PullRequestChecksPageSchema = z.object({
  node: z.object({
    baseRef: z.object({ target: z.object({ oid: OidSchema }).nullable() }).nullable(),
    commits: z.object({
      nodes: z.array(z.object({
        commit: z.object({
          oid: OidSchema,
          statusCheckRollup: z.object({
            contexts: z.object({
              nodes: z.array(CheckContextSchema),
              pageInfo: PageInfoSchema
            })
          }).nullable()
        })
      }))
    }),
    headRefOid: OidSchema.nullable(),
    isDraft: z.boolean(),
    mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
    number: z.number().int().positive(),
    state: z.enum(['OPEN', 'CLOSED', 'MERGED'])
  }).nullable()
})

export type GithubBackend = {
  kind: 'gh' | 'gh-axi'
  version: string
}

export type GithubAuthenticationObservation = {
  actor: { id: string; login: string; nodeId: string }
  backend: GithubBackend
  credentialSource: 'GH_TOKEN' | 'GITHUB_TOKEN' | 'stored-account'
  host: typeof GITHUB_HOST
  observedAt: string
}

export type GithubRepositoryObservation = {
  defaultBranch: string
  id: string
  isFork: boolean
  nameWithOwner: string
  networkRootRepositoryId: string
  nodeId: string
  owner: { id: string; login: string; nodeId: string }
}

export type GithubPullRequestObservation = {
  baseBranch: string
  baseOid: string
  baseRepositoryId: string
  baseRepositoryNodeId: string
  body: string
  draft: boolean
  headBranch: string
  headOid: string | null
  headRepositoryId: string | null
  headRepositoryNodeId: string | null
  id: string
  number: number
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  title: string
  url: string
}

export type GithubIssueCommentObservation = {
  author: { id: string; login: string } | null
  body: string
  createdAt: string
  id: string
  updatedAt: string
  url: string
}

export type GithubCheckBucket = 'pass' | 'fail' | 'pending' | 'cancel' | 'skip'

export type GithubCheckObservation = {
  bucket: GithubCheckBucket
  conclusion: string | null
  kind: 'check-run' | 'status'
  name: string
  status: string
  url: string | null
}

export type GithubPullRequestChecksObservation = {
  baseRefOid: string | null
  checks: GithubCheckObservation[]
  draft: boolean
  headOid: string | null
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  number: number
  state: 'OPEN' | 'CLOSED' | 'MERGED'
}

export type GithubMutationAttempt = {
  attemptedAt: string
  backend: GithubBackend
  operation: 'create-pull-request' | 'create-comment' | 'update-comment' | 'update-pull-request'
  requiresReconciliation: true
}

type AuthorityOptions = {
  env?: NodeJS.ProcessEnv
  maxReadAttempts?: number
  now?: () => Date
  runner?: CommandRunner
  sleep?: (milliseconds: number) => Promise<void>
}

const PULL_REQUESTS_QUERY = `query PullRequests($owner: String!, $name: String!, $baseBranch: String!, $headBranch: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    id
    pullRequests(states: [OPEN, CLOSED, MERGED], baseRefName: $baseBranch, headRefName: $headBranch, first: 100, after: $cursor, orderBy: {field: CREATED_AT, direction: ASC}) {
      nodes {
        id number url state isDraft title body baseRefName baseRefOid headRefName headRefOid
        baseRepository { databaseId id nameWithOwner }
        headRepository { databaseId id nameWithOwner }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`

const COMMENTS_QUERY = `query IssueComments($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on PullRequest {
      comments(first: 100, after: $cursor) {
        nodes { id body createdAt updatedAt url author { login ... on Node { id } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`

const PULL_REQUEST_CHECKS_QUERY = `query PullRequestChecks($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on PullRequest {
      number state isDraft mergeable headRefOid
      baseRef { target { oid } }
      commits(last: 1) {
        nodes { commit { oid statusCheckRollup { contexts(first: 100, after: $cursor) {
          nodes {
            __typename
            ... on CheckRun { name status conclusion detailsUrl }
            ... on StatusContext { context state targetUrl }
          }
          pageInfo { hasNextPage endCursor }
        } } } }
      }
    }
  }
}`

export class GithubAuthority {
  readonly #env: NodeJS.ProcessEnv
  readonly #maxReadAttempts: number
  readonly #now: () => Date
  readonly #runner: CommandRunner
  readonly #sleep: (milliseconds: number) => Promise<void>
  readonly #ghVersion: string
  #backend: GithubBackend

  private constructor(backend: GithubBackend, ghVersion: string, options: AuthorityOptions) {
    this.#backend = backend
    this.#ghVersion = ghVersion
    this.#runner = options.runner ?? runCommand
    this.#now = options.now ?? (() => new Date())
    this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
    this.#maxReadAttempts = options.maxReadAttempts ?? 3
    this.#env = { ...(options.env ?? process.env) }
    delete this.#env.GH_HOST
    delete this.#env.GH_REPO
    delete this.#env.GH_ENTERPRISE_TOKEN
    delete this.#env.GITHUB_ENTERPRISE_TOKEN
  }

  static async connect(options: AuthorityOptions = {}): Promise<GithubAuthority> {
    const runner = options.runner ?? runCommand
    const env = { ...(options.env ?? process.env) }
    const gh = await runner('gh', ['--version'], { env })
    if (gh.code !== 0) {
      throw new GithubAuthorityError('prerequisite', 'connect', 'GitHub CLI `gh` is required')
    }

    const help = await runner('gh-axi', ['api', '--help'], { env })
    const helpText = `${help.stdout}\n${help.stderr}`
    if (help.code === 0 && helpText.includes('--full') && helpText.includes('--hostname')) {
      const version = await runner('gh-axi', ['--version'], { env })
      if (version.code === 0) {
        return new GithubAuthority(
          { kind: 'gh-axi', version: firstLine(version.stdout) },
          firstLine(gh.stdout),
          options
        )
      }
    }
    return new GithubAuthority(
      { kind: 'gh', version: firstLine(gh.stdout) },
      firstLine(gh.stdout),
      options
    )
  }

  backend(): GithubBackend {
    return { ...this.#backend }
  }

  async observeAuthentication(): Promise<GithubAuthenticationObservation> {
    const user = await this.#restRead('observe-authentication', '/user', ActorSchema)
    return {
      actor: { id: user.id, login: user.login, nodeId: user.node_id },
      backend: this.backend(),
      credentialSource: this.#env.GH_TOKEN
        ? 'GH_TOKEN'
        : this.#env.GITHUB_TOKEN
          ? 'GITHUB_TOKEN'
          : 'stored-account',
      host: GITHUB_HOST,
      observedAt: this.#now().toISOString()
    }
  }

  async observeRepository(reference: string): Promise<GithubRepositoryObservation> {
    const { name, owner } = parseGithubRepositoryReference(reference)
    const repository = await this.#restRead(
      'observe-repository',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      RepositorySchema
    )
    const networkRoot = repository.source ?? (repository.fork ? repository.parent : repository)
    if (!networkRoot) {
      throw new GithubAuthorityError(
        'malformed',
        'observe-repository',
        'fork response omitted its network root identity'
      )
    }
    return {
      defaultBranch: repository.default_branch,
      id: repository.id,
      isFork: repository.fork,
      nameWithOwner: repository.full_name,
      networkRootRepositoryId: networkRoot.id,
      nodeId: repository.node_id,
      owner: {
        id: repository.owner.id,
        login: repository.owner.login,
        nodeId: repository.owner.node_id
      }
    }
  }

  async observePullRequests(input: {
    baseBranch: string
    baseRepositoryId: string
    baseRepositoryName: string
    baseRepositoryNodeId: string
    candidateHeadOid: string
    headBranch: string
    headRepositoryId: string
    headRepositoryNodeId: string
  }): Promise<{ exact: GithubPullRequestObservation | null; nearMatches: GithubPullRequestObservation[] }> {
    const { name, owner } = parseGithubRepositoryReference(input.baseRepositoryName)
    const nodes: z.infer<typeof PullRequestNodeSchema>[] = []
    let cursor: string | null = null
    const seen = new Set<string>()
    do {
      const data = await this.#graphqlRead(
        'observe-pull-requests',
        PULL_REQUESTS_QUERY,
      // Branch names narrow the server response; fork disambiguation and the
      // exact route tuple stay client-side.
        { baseBranch: input.baseBranch, cursor, headBranch: input.headBranch, name, owner },
        PullRequestPageSchema
      )
      if (!data.repository) {
        throw new GithubAuthorityError('ambiguous', 'observe-pull-requests', 'repository is absent or inaccessible')
      }
      if (data.repository.id !== input.baseRepositoryNodeId) {
        throw new GithubAuthorityError('identity-drift', 'observe-pull-requests', 'base repository identity changed')
      }
      nodes.push(...data.repository.pullRequests.nodes)
      cursor = nextCursor(data.repository.pullRequests.pageInfo, seen, 'observe-pull-requests')
    } while (cursor)

    const observations = nodes.map(normalizePullRequest)
    const exact = observations.filter((pullRequest) =>
      pullRequest.baseBranch === input.baseBranch &&
      pullRequest.baseRepositoryId === input.baseRepositoryId &&
      pullRequest.headBranch === input.headBranch &&
      pullRequest.headRepositoryId === input.headRepositoryId &&
      pullRequest.headOid === input.candidateHeadOid
    )
    if (exact.length > 1) {
      throw new GithubAuthorityError('ambiguous', 'observe-pull-requests', 'multiple exact pull requests exist')
    }
    const nearMatches = observations.filter((pullRequest) =>
      !exact.includes(pullRequest) &&
      (pullRequest.baseBranch === input.baseBranch ||
        pullRequest.headBranch === input.headBranch ||
        pullRequest.headRepositoryNodeId === input.headRepositoryNodeId)
    )
    return { exact: exact[0] ?? null, nearMatches }
  }

  async observeIssueComments(pullRequestNodeId: string): Promise<GithubIssueCommentObservation[]> {
    NodeIdSchema.parse(pullRequestNodeId)
    const comments: GithubIssueCommentObservation[] = []
    let cursor: string | null = null
    const seen = new Set<string>()
    do {
      const data = await this.#graphqlRead(
        'observe-issue-comments',
        COMMENTS_QUERY,
        { cursor, id: pullRequestNodeId },
        CommentPageSchema
      )
      if (!data.node) {
        throw new GithubAuthorityError('ambiguous', 'observe-issue-comments', 'pull request is absent or inaccessible')
      }
      comments.push(...data.node.comments.nodes.map((comment) => ({
        author: comment.author,
        body: comment.body,
        createdAt: comment.createdAt,
        id: comment.id,
        updatedAt: comment.updatedAt,
        url: comment.url
      })))
      cursor = nextCursor(data.node.comments.pageInfo, seen, 'observe-issue-comments')
    } while (cursor)
    return comments
  }

  async observePullRequestChecks(pullRequestNodeId: string): Promise<GithubPullRequestChecksObservation> {
    NodeIdSchema.parse(pullRequestNodeId)
    const operation = 'observe-pull-request-checks'
    const checks: GithubCheckObservation[] = []
    let cursor: string | null = null
    const seen = new Set<string>()
    let observation: Omit<GithubPullRequestChecksObservation, 'checks'> | undefined
    do {
      const data = await this.#graphqlRead(
        operation,
        PULL_REQUEST_CHECKS_QUERY,
        { cursor, id: pullRequestNodeId },
        PullRequestChecksPageSchema
      )
      if (!data.node) {
        throw new GithubAuthorityError('ambiguous', operation, 'pull request is absent or inaccessible')
      }
      const commit = data.node.commits.nodes.at(-1)?.commit
      if (commit && data.node.headRefOid && commit.oid !== data.node.headRefOid) {
        throw new GithubAuthorityError('identity-drift', operation, 'pull request head changed while observing checks')
      }
      if (observation && commit?.oid !== observation.headOid) {
        throw new GithubAuthorityError('identity-drift', operation, 'pull request head changed between check pages')
      }
      observation ??= {
        baseRefOid: data.node.baseRef?.target?.oid ?? null,
        draft: data.node.isDraft,
        headOid: data.node.headRefOid,
        mergeable: data.node.mergeable,
        number: data.node.number,
        state: data.node.state
      }
      const contexts = commit?.statusCheckRollup?.contexts
      if (!contexts) break
      checks.push(...contexts.nodes.map((context) => context.__typename === 'CheckRun'
        ? {
          bucket: checkBucket('check-run', context.status, context.conclusion),
          conclusion: context.conclusion,
          kind: 'check-run' as const,
          name: context.name,
          status: context.status,
          url: context.detailsUrl
        }
        : {
          bucket: checkBucket('status', 'COMPLETED', context.state),
          conclusion: context.state,
          kind: 'status' as const,
          name: context.context,
          status: 'COMPLETED',
          url: context.targetUrl
        }))
      cursor = nextCursor(contexts.pageInfo, seen, operation)
    } while (cursor)
    return { ...observation, checks }
  }

  async createPullRequest(input: {
    baseBranch: string
    baseRepositoryNodeId: string
    body: string
    draft: boolean
    headRefName: string
    title: string
  }): Promise<GithubMutationAttempt> {
    const variables = z.object({
      baseBranch: RefSchema,
      baseRepositoryNodeId: NodeIdSchema,
      body: z.string(),
      draft: z.boolean(),
      headRefName: RefSchema,
      title: z.string().min(1)
    }).parse(input)
    await this.#graphqlMutation(
      'create-pull-request',
      `mutation CreatePullRequest($input: CreatePullRequestInput!) {
        createPullRequest(input: $input) { pullRequest { id } }
      }`,
      {
        input: {
          baseRefName: variables.baseBranch,
          body: variables.body,
          draft: variables.draft,
          headRefName: variables.headRefName,
          repositoryId: variables.baseRepositoryNodeId,
          title: variables.title
        }
      },
      z.object({ createPullRequest: z.object({ pullRequest: z.object({ id: NodeIdSchema }) }) })
    )
    return this.#mutationAttempt('create-pull-request')
  }

  async updatePullRequest(input: {
    body: string
    pullRequestId: string
    title: string
  }): Promise<GithubMutationAttempt> {
    const variables = z.object({
      body: z.string(),
      pullRequestId: NodeIdSchema,
      title: z.string().min(1)
    }).parse(input)
    await this.#graphqlMutation(
      'update-pull-request',
      `mutation UpdatePullRequest($input: UpdatePullRequestInput!) {
        updatePullRequest(input: $input) { pullRequest { id } }
      }`,
      { input: { body: variables.body, pullRequestId: variables.pullRequestId, title: variables.title } },
      z.object({ updatePullRequest: z.object({ pullRequest: z.object({ id: z.literal(variables.pullRequestId) }) }) })
    )
    return this.#mutationAttempt('update-pull-request')
  }

  async createIssueComment(input: { body: string; subjectId: string }): Promise<GithubMutationAttempt> {
    const variables = z.object({ body: z.string(), subjectId: NodeIdSchema }).parse(input)
    await this.#graphqlMutation(
      'create-comment',
      `mutation AddComment($input: AddCommentInput!) {
        addComment(input: $input) { commentEdge { node { id } } }
      }`,
      { input: variables },
      z.object({ addComment: z.object({ commentEdge: z.object({ node: z.object({ id: NodeIdSchema }) }) }) })
    )
    return this.#mutationAttempt('create-comment')
  }

  async updateIssueComment(input: { body: string; commentId: string }): Promise<GithubMutationAttempt> {
    const variables = z.object({ body: z.string(), commentId: NodeIdSchema }).parse(input)
    await this.#graphqlMutation(
      'update-comment',
      `mutation UpdateIssueComment($input: UpdateIssueCommentInput!) {
        updateIssueComment(input: $input) { issueComment { id } }
      }`,
      { input: { body: variables.body, id: variables.commentId } },
      z.object({ updateIssueComment: z.object({ issueComment: z.object({ id: NodeIdSchema }) }) })
    )
    return this.#mutationAttempt('update-comment')
  }

  async #restRead<T>(operation: string, endpoint: string, schema: z.ZodType<T>): Promise<T> {
    return this.#read(operation, async () => parseAuthority(schema, await this.#requestJson('GET', endpoint), operation))
  }

  async #graphqlRead<T>(
    operation: string,
    query: string,
    variables: Record<string, unknown>,
    schema: z.ZodType<T>
  ): Promise<T> {
    return this.#read(operation, async () => {
      const envelope = parseAuthority(
        GraphqlEnvelopeSchema,
        await this.#requestJson('POST', 'graphql', { query, variables }),
        operation
      )
      if (envelope.errors) throw graphqlFailure(envelope.errors, operation)
      if (envelope.data === undefined) {
        throw new GithubAuthorityError('malformed', operation, 'GraphQL response omitted data')
      }
      return parseAuthority(schema, envelope.data, operation)
    })
  }

  async #graphqlMutation<T>(
    operation: string,
    query: string,
    variables: Record<string, unknown>,
    schema: z.ZodType<T>
  ): Promise<void> {
    let raw: unknown
    try {
      raw = await this.#requestJson('POST', 'graphql', { query, variables }, true)
    } catch (error) {
      if (error instanceof GithubAuthorityError &&
          ['authentication', 'authorization'].includes(error.kind)) throw error
      throw new GithubAuthorityError(
        'mutation-indeterminate',
        operation,
        'mutation outcome requires authoritative reconciliation'
      )
    }
    const envelope = parseMutation(GraphqlEnvelopeSchema, raw, operation)
    if (envelope.errors || envelope.data === undefined) {
      const classified = envelope.errors && graphqlFailure(envelope.errors, operation)
      if (classified && ['authentication', 'authorization'].includes(classified.kind)) throw classified
      throw new GithubAuthorityError(
        'mutation-indeterminate',
        operation,
        'mutation outcome requires authoritative reconciliation'
      )
    }
    parseMutation(schema, envelope.data, operation)
  }

  async #read<T>(operation: string, action: () => Promise<T>): Promise<T> {
    let attempt = 0
    let fellBack = false
    while (true) {
      attempt += 1
      try {
        return await action()
      } catch (error) {
        const authorityError = error instanceof GithubAuthorityError
          ? error
          : new GithubAuthorityError('unavailable', operation, 'GitHub authority read failed')
        if (!fellBack && this.#backend.kind === 'gh-axi' &&
            ['malformed', 'prerequisite', 'unavailable'].includes(authorityError.kind)) {
          this.#backend = { kind: 'gh', version: this.#ghVersion }
          fellBack = true
          attempt = 0
          continue
        }
        if (!['rate-limit', 'unavailable'].includes(authorityError.kind) || attempt >= this.#maxReadAttempts) {
          throw authorityError
        }
        await this.#sleep(attempt * 100)
      }
    }
  }

  async #requestJson(
    method: 'GET' | 'POST',
    endpoint: string,
    body?: Record<string, unknown>,
    mutation = false
  ): Promise<unknown> {
    const headers = ['Accept: application/vnd.github+json', 'X-GitHub-Api-Version: 2022-11-28']
    const args = this.#backend.kind === 'gh-axi'
      ? ['api', '--hostname', GITHUB_HOST, '--full', method, endpoint]
      : ['api', endpoint, '--hostname', GITHUB_HOST, '--method', method]
    for (const header of headers) args.push('--header', header)
    let input: string | undefined
    if (body) {
      args.push('--input', '-')
      input = JSON.stringify(body)
    }
    const result = await this.#runner(this.#backend.kind, args, { env: this.#env, input })
    if (result.code !== 0) {
      const failure = commandFailure(result)
      if (mutation && ['rate-limit', 'unavailable', 'ambiguous'].includes(failure)) {
        throw new GithubAuthorityError(
          'mutation-indeterminate',
          endpoint,
          'mutation outcome requires authoritative reconciliation'
        )
      }
      throw new GithubAuthorityError(failure, endpoint, `GitHub request failed: ${failure}`)
    }
    try {
      return JSON.parse(result.stdout)
    } catch {
      throw new GithubAuthorityError(
        mutation ? 'mutation-indeterminate' : 'malformed',
        endpoint,
        mutation
          ? 'mutation outcome requires authoritative reconciliation'
          : 'GitHub returned malformed JSON'
      )
    }
  }

  #mutationAttempt(operation: GithubMutationAttempt['operation']): GithubMutationAttempt {
    return {
      attemptedAt: this.#now().toISOString(),
      backend: this.backend(),
      operation,
      requiresReconciliation: true
    }
  }
}

export function assertGithubAuthenticationIdentity(
  expected: GithubAuthenticationObservation,
  actual: GithubAuthenticationObservation
): void {
  if (expected.host !== actual.host ||
      expected.actor.id !== actual.actor.id ||
      expected.actor.nodeId !== actual.actor.nodeId) {
    throw new GithubAuthorityError('identity-drift', 'authenticate', 'authenticated GitHub actor changed')
  }
}

export function assertGithubPublicationRouteIdentity(
  expected: RepositoryPublicationRouteRow,
  actual: RepositoryPublicationRouteInput
): void {
  const stable = expected.forge_host === actual.forgeHost &&
    expected.base_repository_id === actual.baseRepositoryId &&
    expected.base_repository_node_id === actual.baseRepositoryNodeId &&
    expected.head_repository_id === actual.headRepositoryId &&
    expected.head_repository_node_id === actual.headRepositoryNodeId &&
    expected.network_root_repository_id === actual.networkRootRepositoryId &&
    expected.head_owner === actual.headOwner &&
    expected.head_branch === actual.headBranch &&
    expected.base_branch === actual.baseBranch
  if (!stable) {
    throw new GithubAuthorityError('identity-drift', 'publication-route', 'publication route identity changed')
  }
}

export async function resolveGithubPublicationRoute(input: {
  baseBranch?: string
  commandRunner?: CommandRunner
  env?: NodeJS.ProcessEnv
  fork?: string
  headBranch?: string
  ledger: DomainLedger
  provider: GithubAuthority
  repoPath: string
  upstream?: string
}): Promise<RepositoryPublicationRouteInput & { routeFingerprint: string }> {
  const env = { ...(input.env ?? process.env) }
  const runner = input.commandRunner ?? runCommand
  // Key the route by the same canonical repository root run admission uses
  // (realpath of `git rev-parse --show-toplevel`), never the raw CLI argument.
  const repoRoot = await realpath(await gitValue(
    runner,
    ['-C', input.repoPath, 'rev-parse', '--path-format=absolute', '--show-toplevel'],
    env,
    'resolve repository root'
  ))
  const upstream = input.upstream ?? await gitValue(
    runner,
    ['-C', repoRoot, 'remote', 'get-url', 'origin'],
    env,
    'read origin remote'
  )
  const headBranch = input.headBranch ?? await gitValue(
    runner,
    ['-C', repoRoot, 'branch', '--show-current'],
    env,
    'read current branch'
  )
  const baseReference = formatRepositoryReference(parseGithubRepositoryReference(upstream))
  const headReference = input.fork
    ? formatRepositoryReference(parseGithubRepositoryReference(input.fork))
    : baseReference
  const authentication = await input.provider.observeAuthentication()
  const existing = input.ledger.repositoryPublicationRoute(repoRoot)
  if (existing && (
    existing.actor_id !== authentication.actor.id ||
    (existing.actor_node_id !== null && existing.actor_node_id !== authentication.actor.nodeId)
  )) {
    throw new GithubAuthorityError(
      'identity-drift',
      'resolve-publication-route',
      'authenticated GitHub actor changed'
    )
  }
  const baseRepository = await input.provider.observeRepository(baseReference)
  const headRepository = headReference === baseReference
    ? baseRepository
    : await input.provider.observeRepository(headReference)
  if (baseRepository.networkRootRepositoryId !== headRepository.networkRootRepositoryId) {
    throw new GithubAuthorityError(
      'identity-drift',
      'resolve-publication-route',
      'base and head repositories are not in the same fork network'
    )
  }

  const route: RepositoryPublicationRouteInput = {
    actorId: authentication.actor.id,
    actorLogin: authentication.actor.login,
    actorNodeId: authentication.actor.nodeId,
    backend: authentication.backend.kind,
    backendVersion: authentication.backend.version,
    baseBranch: input.baseBranch ?? baseRepository.defaultBranch,
    baseRepositoryId: baseRepository.id,
    baseRepositoryName: baseRepository.nameWithOwner,
    baseRepositoryNodeId: baseRepository.nodeId,
    credentialSource: authentication.credentialSource,
    forgeHost: GITHUB_HOST,
    headBranch,
    headOwner: headRepository.owner.login,
    headRepositoryId: headRepository.id,
    headRepositoryName: headRepository.nameWithOwner,
    headRepositoryNodeId: headRepository.nodeId,
    networkRootRepositoryId: baseRepository.networkRootRepositoryId,
    observedAt: authentication.observedAt,
    repoRoot
  }
  const routeFingerprint = input.ledger.setRepositoryPublicationRoute(route)
  return { ...route, routeFingerprint }
}

export function checkBucket(
  kind: GithubCheckObservation['kind'],
  status: string,
  conclusion: string | null
): GithubCheckBucket {
  if (kind === 'status') {
    if (conclusion === 'SUCCESS') return 'pass'
    if (conclusion === 'PENDING' || conclusion === 'EXPECTED') return 'pending'
    return 'fail'
  }
  if (status !== 'COMPLETED') return 'pending'
  switch (conclusion) {
    case 'SUCCESS': return 'pass'
    case 'NEUTRAL':
    case 'SKIPPED': return 'skip'
    case 'CANCELLED':
    case 'STALE': return 'cancel'
    default: return 'fail'
  }
}

export function parseGithubRepositoryReference(value: string): { name: string; owner: string } {
  const trimmed = value.trim()
  let pathname = trimmed
  if (/^[^/@\s]+@github\.com:/i.test(trimmed)) {
    pathname = trimmed.slice(trimmed.indexOf(':') + 1)
  } else if (/^[a-z][a-z\d+.-]*:/i.test(trimmed)) {
    let url: URL
    try {
      url = new URL(trimmed)
    } catch {
      throw invalidRepositoryReference()
    }
    if (url.hostname.toLowerCase() !== GITHUB_HOST || url.username && url.username !== 'git' || url.password) {
      throw invalidRepositoryReference()
    }
    pathname = url.pathname
  }
  const parts = pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/')
  if (parts.length !== 2 || parts.some((part) => !part || /[\s?#]/.test(part))) {
    throw invalidRepositoryReference()
  }
  return { name: parts[1], owner: parts[0] }
}

function formatRepositoryReference(reference: { name: string; owner: string }): string {
  return `${reference.owner}/${reference.name}`
}

function invalidRepositoryReference(): GithubAuthorityError {
  return new GithubAuthorityError(
    'prerequisite',
    'parse-repository-reference',
    'repository must identify owner/name on github.com'
  )
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0] || 'unknown'
}

function parseAuthority<T>(schema: z.ZodType<T>, value: unknown, operation: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new GithubAuthorityError('malformed', operation, 'GitHub response failed schema validation')
  }
  return parsed.data
}

function parseMutation<T>(schema: z.ZodType<T>, value: unknown, operation: string): T {
  try {
    return parseAuthority(schema, value, operation)
  } catch {
    throw new GithubAuthorityError(
      'mutation-indeterminate',
      operation,
      'mutation outcome requires authoritative reconciliation'
    )
  }
}

function graphqlFailure(errors: z.infer<typeof GraphqlErrorSchema>[], operation: string): GithubAuthorityError {
  const text = errors.map((error) => error.message).join(' ').toLowerCase()
  if (/rate limit|rate_limit|abuse/.test(text)) {
    return new GithubAuthorityError('rate-limit', operation, 'GitHub rate limit prevented an authoritative response')
  }
  if (/bad credentials|requires authentication|not authenticated/.test(text)) {
    return new GithubAuthorityError('authentication', operation, 'GitHub authentication failed')
  }
  if (/forbidden|resource not accessible|permission/.test(text)) {
    return new GithubAuthorityError('authorization', operation, 'GitHub authorization failed')
  }
  if (/could not resolve|not found/.test(text)) {
    return new GithubAuthorityError('ambiguous', operation, 'GitHub resource is absent or inaccessible')
  }
  return new GithubAuthorityError('malformed', operation, 'GraphQL response contained errors')
}

function commandFailure(result: CommandResult): GithubAuthorityFailure {
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase()
  if (result.code === 127) return 'prerequisite'
  if (/401|bad credentials|authentication failed|not logged/.test(text)) return 'authentication'
  if (/rate limit|rate_limit|secondary rate|429|abuse/.test(text)) return 'rate-limit'
  if (/403|forbidden|resource not accessible|permission denied/.test(text)) return 'authorization'
  if (/404|not found/.test(text)) return 'ambiguous'
  return 'unavailable'
}

function nextCursor(
  pageInfo: z.infer<typeof PageInfoSchema>,
  seen: Set<string>,
  operation: string
): string | null {
  if (!pageInfo.hasNextPage) return null
  if (!pageInfo.endCursor || seen.has(pageInfo.endCursor)) {
    throw new GithubAuthorityError(
      'incomplete-pagination',
      operation,
      'GitHub pagination did not advance'
    )
  }
  seen.add(pageInfo.endCursor)
  return pageInfo.endCursor
}

function normalizePullRequest(
  pullRequest: z.infer<typeof PullRequestNodeSchema>
): GithubPullRequestObservation {
  return {
    baseBranch: pullRequest.baseRefName,
    baseOid: pullRequest.baseRefOid,
    baseRepositoryId: pullRequest.baseRepository.databaseId,
    baseRepositoryNodeId: pullRequest.baseRepository.id,
    body: pullRequest.body,
    draft: pullRequest.isDraft,
    headBranch: pullRequest.headRefName,
    headOid: pullRequest.headRefOid,
    headRepositoryId: pullRequest.headRepository?.databaseId ?? null,
    headRepositoryNodeId: pullRequest.headRepository?.id ?? null,
    id: pullRequest.id,
    number: pullRequest.number,
    state: pullRequest.state,
    title: pullRequest.title,
    url: pullRequest.url
  }
}

async function gitValue(
  runner: CommandRunner,
  args: string[],
  env: NodeJS.ProcessEnv,
  operation: string
): Promise<string> {
  const result = await runner('git', args, { env })
  const value = result.stdout.trim()
  if (result.code !== 0 || !value) {
    throw new GithubAuthorityError('prerequisite', operation, `could not ${operation}`)
  }
  return value
}
