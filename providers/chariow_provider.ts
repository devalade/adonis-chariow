import type { ApplicationService } from '@adonisjs/core/types'

import { Chariow } from '../src/chariow.ts'
import type { ChariowConfig } from '../src/define_config.ts'

declare module '@adonisjs/core/types' {
  interface ContainerBindings {
    chariow: Chariow
  }
}

/**
 * Registers a single Chariow instance, built from `config/chariow.ts`.
 */
export default class ChariowProvider {
  constructor(protected app: ApplicationService) {}

  register(): void {
    this.app.container.singleton('chariow', async () => {
      const config = this.app.config.get<ChariowConfig>('chariow')
      return new Chariow(config)
    })
  }
}
