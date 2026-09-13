import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { addAbortListener } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { promisify } from 'node:util'
import type { CommandGate } from './config.ts'
import { cleanGitEnvironment } from './ledger.ts'

const exec = promisify(execFile)
export const COMMAND_OUTPUT_LIMIT = 64 * 1024
export const COMMAND_TRUNCATION_MARKER = '\n[command output truncated]\n'
const active = new Map<AbortController, Promise<unknown>>()

async function worktreeGit(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal }): Promise<void> {
  options.signal.throwIfAborted()
  const pending = exec('git', ['worktree', ...args], { ...options, killSignal: 'SIGKILL' })
  const closed = new Promise<void>((resolve) => pending.child.once('close', () => resolve()))
  // execFile does not forward killSignal to its AbortSignal handler, and its
  // abort rejection can precede exit. Kill explicitly and wait before cleanup.
  const abort = addAbortListener(options.signal, () => { pending.child.kill('SIGKILL') })
  try { await pending } finally {
    abort[Symbol.dispose]()
    await closed
  }
}
// Keep the group leader live until the owner kills the group: signalling an
// already-exited leader's numeric PGID can target a reused process identity.
const supervisor = `
  const { spawn } = require('node:child_process');
  setInterval(() => {}, 60000);
  const shell = spawn('/bin/sh', ['-c', process.argv[1]], { stdio: ['ignore', 'inherit', 'inherit'] });
  shell.on('error', () => process.send({ exitCode: 1 }));
  shell.on('exit', (code) => process.send({ exitCode: code ?? 1 }));
`

export async function cancelCommandGates(): Promise<void> {
  for (const controller of active.keys()) controller.abort()
  await Promise.allSettled(active.values())
}

/** Commands share a process group so shell children are reaped even after the shell exits. */
export async function runCommandGate(options: {
  gate: CommandGate
  repoRoot: string
  candidate: string
  artifactsDir: string
  signal?: AbortSignal
  onOutput?: (text: string) => void
}): Promise<{ exitCode: number; output: string; truncated: boolean }> {
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  const run = (async () => {
    // The application uses POSIX process ownership; do not pretend a Windows
    // shell kill also cleans up its descendants.
    if (process.platform === 'win32') throw new Error('Command gates require POSIX process groups')
    signal.throwIfAborted()
    const directory = await mkdtemp(path.join(options.artifactsDir, 'command-worktree-'))
    const worktree = path.join(directory, 'candidate')
    const env = cleanGitEnvironment()
    let added = false
    try {
      await worktreeGit(['add', '--detach', worktree, options.candidate], { cwd: options.repoRoot, env, signal })
      added = true
      signal.throwIfAborted()
      return await new Promise<{ exitCode: number; output: string; truncated: boolean }>((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', supervisor, options.gate.command], {
          cwd: worktree, env, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
        })
        const chunks: Buffer[] = []
        const decoder = new StringDecoder('utf8')
        let bytes = 0
        let truncated = false
        let failure: Error | undefined
        let exitCode: number | undefined
        let exited = false
        let settled = false
        const stop = () => {
          if (child.pid === undefined || exited) return
          try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure = error as Error
          }
        }
        const capture = (chunk: Buffer) => {
          if (settled) return
          const remaining = COMMAND_OUTPUT_LIMIT - bytes
          if (remaining > 0) {
            const kept = chunk.subarray(0, remaining)
            chunks.push(kept)
            bytes += kept.length
            const text = decoder.write(kept)
            if (text) options.onOutput?.(text)
          }
          if (chunk.length > remaining && !truncated) {
            truncated = true
            options.onOutput?.(COMMAND_TRUNCATION_MARKER)
          }
        }
        // Detached descendants can hold the inherited pipes open long after the
        // owned group is gone, so settlement follows process exit, not close.
        const settle = () => {
          if (settled) return
          settled = true
          signal.removeEventListener('abort', stop)
          child.stdout!.destroy()
          child.stderr!.destroy()
          if (signal.aborted) reject(signal.reason)
          else if (failure) reject(failure)
          else resolve({ exitCode: exitCode ?? 1, output: Buffer.concat(chunks).toString('utf8'), truncated })
        }
        child.stdout!.on('data', capture)
        child.stderr!.on('data', capture)
        child.on('error', (error) => { failure = error; settle() })
        child.on('message', (message) => {
          exitCode = (message as { exitCode: number }).exitCode
          stop()
        })
        child.on('exit', () => { exited = true; setImmediate(settle) })
        signal.addEventListener('abort', stop, { once: true })
        if (signal.aborted) stop()
      })
    } finally {
      // Interrupted setup can leave a registered, still-initializing worktree.
      // Cleanup must run even after cancellation, but Git itself may stall.
      if (added || existsSync(path.join(worktree, '.git'))) await worktreeGit(['remove', '--force', '--force', worktree], {
        cwd: options.repoRoot, env, signal: AbortSignal.timeout(120_000)
      })
      await rm(directory, { recursive: true, force: true })
    }
  })()
  active.set(controller, run)
  try { return await run } finally { active.delete(controller) }
}
