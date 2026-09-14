import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

export function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export async function repository() {
  const directory = await mkdtemp(path.join(tmpdir(), 'onm-command-gates-'))
  const root = path.join(directory, 'repo')
  const artifactsDir = path.join(directory, 'artifacts')
  await mkdir(root)
  await mkdir(artifactsDir)
  git(root, 'init', '-b', 'feature')
  await writeFile(path.join(root, 'value'), 'bad')
  await writeFile(path.join(root, 'check.cjs'), "const fs = require('node:fs'); const value = fs.readFileSync('value', 'utf8'); console.log(value); process.exit(value === 'good' ? 0 : 7)\n")
  git(root, 'add', '.')
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial')
  const initial = git(root, 'rev-parse', 'HEAD')
  await writeFile(path.join(root, 'value'), 'good')
  git(root, 'add', 'value')
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'repair')
  const repaired = git(root, 'rev-parse', 'HEAD')
  git(root, 'reset', '--hard', initial)
  return { root, artifactsDir, initial, repaired, directory, cleanup: () => rm(directory, { recursive: true, force: true }) }
}
