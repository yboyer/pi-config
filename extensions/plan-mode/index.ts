import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { registerPlanCommands } from './commands.ts'
import { registerPlanEvents } from './events.ts'
import { createPlanModeRuntime } from './runtime.ts'
import { registerPlanTools } from './tools.ts'

export default function (pi: ExtensionAPI) {
  const runtime = createPlanModeRuntime(pi)

  registerPlanCommands(pi, runtime)
  registerPlanTools(pi, runtime)
  registerPlanEvents(pi, runtime)
}
