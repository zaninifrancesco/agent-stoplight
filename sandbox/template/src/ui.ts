import { greet } from './api'

export function renderBanner(name: string): string {
  return `=== ${greet(name)} ===`
}
