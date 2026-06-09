import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

const execFileAsync = promisify(execFile)

const TITLE = process.env.PI_NOTIFY_TITLE?.trim() || 'Pi'
const MESSAGE = process.env.PI_NOTIFY_MESSAGE?.trim() || 'Ready for input'

async function tryExec(file: string, args: string[]) {
  try {
    await execFileAsync(file, args, { timeout: 3_000, maxBuffer: 64 * 1024 })
    return true
  } catch {
    return false
  }
}

async function notifyDesktop(title: string, message: string) {
  if (process.platform === 'darwin') {
    return tryExec('osascript', [
      '-e',
      `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`,
    ])
  }
}

async function playSound() {
  if (process.platform === 'darwin') {
    return tryExec('afplay', [
      '/System/Library/PrivateFrameworks/ToneLibrary.framework/Versions/A/Resources/AlertTones/EncoreInfinitum/Cheers-EncoreInfinitum.caf',
    ])
  }
}

export default function (pi: ExtensionAPI) {
  pi.on('agent_end', async _event => {
    void notifyDesktop(TITLE, MESSAGE)
    process.stdout.write('\x07')
    void playSound()
  })
}
