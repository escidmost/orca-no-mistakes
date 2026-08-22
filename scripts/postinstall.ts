#!/usr/bin/env node

import { installDefaultUserConfig } from './config.ts'

export function runPostInstall(): void {
  try {
    const result = installDefaultUserConfig()
    if (result.installed) {
      console.log(`orca-no-mistakes: initialized default configuration at ${result.path}`)
    } else {
      console.log(`orca-no-mistakes: existing configuration preserved at ${result.path}`)
    }
  } catch (err) {
    // Non-fatal warning so sandboxed or restricted environments do not fail package installation
    console.warn(
      `orca-no-mistakes: notice: could not initialize default config: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
}

runPostInstall()
