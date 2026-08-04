import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

import { ChariowUnauthorized } from '../src/failures.ts'

/**
 * Confirms the configured API key reaches the right store.
 */
export default class ChariowCheck extends BaseCommand {
  static commandName = 'chariow:check'
  static description = 'Verify the Chariow API key and print the connected store'
  static options: CommandOptions = { startApp: true }

  async run() {
    const chariow = await this.app.container.make('chariow')

    try {
      const store = await chariow.store.get()
      const products = await chariow.products.list({ per_page: 1 })

      this.logger.success(`Connected to "${store.name}" (${store.id})`)
      this.logger.info(`Store URL: ${store.url}`)
      this.logger.info(
        products.data.length > 0
          ? `Products are readable, first one: ${products.data[0].name}`
          : 'No published products yet'
      )
    } catch (error) {
      if (error instanceof ChariowUnauthorized) {
        this.logger.error('Chariow rejected the API key.')
        this.logger.info('Generate or check it at https://app.chariow.com/settings/api')
        this.exitCode = 1
        return
      }

      throw error
    }
  }
}
