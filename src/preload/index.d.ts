import type { DshApi } from './index'

declare global {
  interface Window {
    api: DshApi
  }
}

export {}
