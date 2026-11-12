// Resolume decks (the tabs under the clip grid). Each deck has its own clips on the same
// layers; the timeline marks every cue with the deck it fires from.
import type { ResolumeComposition, ResolumeDeck } from '../../shared/resolume'
import { rv, resolumeColor } from '../../shared/resolume'

// Distinct hues that don't collide with the state colours (mint live, yellow select,
// blue next, orange clip scope, red error)
const DECK_COLORS = ['#8fb3d9', '#c49bff', '#e88fb4', '#7fd1c7', '#d9b86c', '#a3c46b', '#b0a3e0', '#e0a08a']

export interface DeckInfo { id: number; index: number; name: string; selected: boolean; color: string }

export function decksOf(comp: ResolumeComposition | null): DeckInfo[] {
  return (comp?.decks ?? []).filter(Boolean).map((d: ResolumeDeck, i) => ({
    id: d.id, index: i + 1, name: rv(d.name, `Deck ${i + 1}`), selected: !!rv(d.selected, false),
    // Resolume's colour tag when set, else a stable hue per position
    color: resolumeColor(d.colorid) ?? DECK_COLORS[i % DECK_COLORS.length],
  }))
}

/** Deck of a cue: by id, else by name, else by stored position. */
export function deckOfCue(decks: DeckInfo[], cue: { deckId?: number; deckName?: string; deckIndex?: number }): DeckInfo | undefined {
  if (cue.deckId === undefined && cue.deckIndex === undefined) return undefined
  return decks.find(d => d.id === cue.deckId)
    ?? (cue.deckName ? decks.find(d => d.name === cue.deckName) : undefined)
    ?? decks.find(d => d.index === cue.deckIndex)
}
