import assert from 'node:assert/strict'

export function assertStructurallyVisible(body: string, targetPrefix: string): void {
  let currentFence: { char: string; length: number } | null = null

  for (const line of body.split(/\r?\n/)) {
    if (!currentFence) {
      if (line.startsWith(targetPrefix)) return
      const match = line.match(/^[ ]{0,3}(`{3,}|~{3,})(.*)$/)
      if (match) {
        const fenceStr = match[1]
        const fenceChar = fenceStr[0]
        const rest = match[2]
        if (fenceChar === '~' || !rest.includes('`')) {
          currentFence = { char: fenceChar, length: fenceStr.length }
        }
      }
    } else {
      const closeRegex = new RegExp(`^[ ]{0,3}${currentFence.char}{${currentFence.length},}[ \\t]*$`)
      if (closeRegex.test(line)) currentFence = null
    }
  }

  assert.fail(`Expected "${targetPrefix}" to be structurally visible outside any code fences`)
}
