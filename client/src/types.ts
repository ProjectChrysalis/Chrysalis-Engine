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
  /** `update`: a newer version this engine ships for an official app */
  apps: { id: string; name?: string; kind?: string; author?: string | null; official?: boolean; repository?: string | null; update?: string | null }[]
  default?: string | null
}
