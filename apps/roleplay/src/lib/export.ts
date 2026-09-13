import type { Chat, Character } from './types'

/** Trigger a client-side file download for generated text content. */
export function downloadTextFile(filename: string, content: string, mime = 'text/plain') {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function speakerName(chat: Chat, characters: Character[], characterId: string | null, role: string) {
  if (role === 'user') return 'You'
  if (role === 'system') return 'System'
  return characters.find((c) => c.id === (characterId ?? chat.characterId))?.name ?? 'Assistant'
}

function safeSlug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60) || 'chat'
}

/** JSONL chat log: one JSON object per message line. */
export function exportChatJSONL(chat: Chat, characters: Character[]) {
  const lines = chat.messages.map((m) => {
    const swipe = m.swipes[m.activeSwipe] ?? m.swipes[0]
    return JSON.stringify({
      name: speakerName(chat, characters, m.characterId, m.role),
      is_user: m.role === 'user',
      is_system: m.role === 'system',
      send_date: new Date(m.timestamp).toISOString(),
      mes: swipe?.content ?? '',
      swipes: m.swipes.map((s) => s.content),
      swipe_id: m.activeSwipe,
    })
  })
  downloadTextFile(`${safeSlug(chat.title)}.jsonl`, lines.join('\n'), 'application/jsonl')
}

/** Plain-text transcript. */
export function exportChatTxt(chat: Chat, characters: Character[]) {
  const body = chat.messages
    .map((m) => {
      const swipe = m.swipes[m.activeSwipe] ?? m.swipes[0]
      return `${speakerName(chat, characters, m.characterId, m.role)}:\n${swipe?.content ?? ''}\n`
    })
    .join('\n')
  downloadTextFile(`${safeSlug(chat.title)}.txt`, `${chat.title}\n${'='.repeat(chat.title.length)}\n\n${body}`)
}
