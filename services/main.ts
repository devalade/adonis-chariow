import app from '@adonisjs/core/services/app'
import type { Chariow } from '../src/chariow.ts'

let chariow: Chariow

/**
 * Returns the Chariow instance from the container, so an app can
 * `import chariow from '@devalade/adonis-chariow/services/main'`.
 */
await app.booted(async () => {
  chariow = await app.container.make('chariow')
})

export { chariow as default }
