import type Configure from '@adonisjs/core/commands/configure'

import { stubsRoot } from './stubs/main.ts'

/**
 * Runs on `node ace configure @devalade/adonis-chariow`.
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods()

  /**
   * config/chariow.ts
   */
  await codemods.makeUsingStub(stubsRoot, 'config/chariow.stub', {})

  /**
   * app/controllers/chariow_pulses_controller.ts — the webhook receiver.
   */
  await codemods.makeUsingStub(stubsRoot, 'controllers/chariow_pulses_controller.stub', {})

  /**
   * Environment variables.
   */
  await codemods.defineEnvValidations({
    variables: {
      CHARIOW_API_KEY: 'Env.schema.string()',
      CHARIOW_PULSE_SECRET: 'Env.schema.string.optional()',
    },
    leadingComment: 'Variables for @devalade/adonis-chariow',
  })

  /**
   * Provider and command registration.
   */
  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider('@devalade/adonis-chariow/chariow_provider')
    rcFile.addCommand('@devalade/adonis-chariow/commands')
  })

  command.logger.log('')
  command.logger.info('Next steps:')
  command.logger.log('  1. Add CHARIOW_API_KEY to your .env (https://app.chariow.com/settings/api)')
  command.logger.log('  2. Run "node ace chariow:check" to confirm the key works')
  command.logger.log(
    '  3. Point a Pulse at POST /webhooks/chariow and copy its whsec_… secret into CHARIOW_PULSE_SECRET'
  )
}
