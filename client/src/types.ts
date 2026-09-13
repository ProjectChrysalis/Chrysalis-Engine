// Client types for the launcher shell. The agent tab is a separate React app
// (client-agent/) with its own types.

export interface Me {
  username: string
  role: string
  hasPassword?: boolean
  hasAvatar?: boolean
}

export interface LaunchInfo {
  engine?: { version: string; repository: string | null }
  apps: { id: string; name?: string; kind?: string; author?: string | null; official?: boolean; repository?: string | null }[]
  default?: string | null
}

/** One app in the Store list. */
export interface StoreApp {
  id: string
  name: string
  description: string
  author: string
  repository: string
  ref?: string
  tags: string[]
  /** YYYY-MM-DD */
  added: string
  official: boolean
  /** The id of this account's app that came from it. */
  installed: string | null
}

export interface StoreList {
  enabled: boolean
  apps: StoreApp[]
  fetchedAt: number | null
  error?: string
}
