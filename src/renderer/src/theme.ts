// Canvas mirror of styles/tokens.css (canvas cannot read CSS variables cheaply on every
// frame). Keep both files in sync.
export const T = {
  gutter: '#000000',
  well: '#0a0909',
  lane: '#1b1a19',
  laneAlt: '#201f1e',
  track: '#2a2a2a',
  header: '#2c2c2c',
  splitter: '#343434',
  control: '#3a3a39',
  hover: '#494949',
  field: '#525252',

  textHi: '#ffffff',
  text: '#e6e6e6',
  textDim: '#9a9a9a',
  textFaint: '#6e6e6e',
  textOnLive: '#111111',

  live: '#a1fcd5',
  liveFill: '#5c8a76',
  liveDeep: '#345145',
  select: '#ffd34d',
  selectDim: '#9c8130',
  next: '#7fb8ff',
  loop: '#f2a33a',
  danger: '#ff5c5c',
  dangerFill: '#b3261e',

  fontUi: '"Noto Sans", "Open Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  fontCond: '"Noto Sans Condensed", "Open Sans Condensed", "Roboto Condensed", "Arial Narrow", -apple-system, sans-serif',
  fontTc: '"JetBrains Mono", "IBM Plex Mono", "SF Mono", Menlo, Consolas, monospace',
} as const

// Identity colours for new layers / rundown entries: muted fills that keep white
// text readable (≥ 5:1), in the spirit of Resolume's colour tags.
export const TAG_COLORS = [
  '#56636e', // slate
  '#4f6d60', // sage
  '#7a625a', // rose
  '#5a5f8a', // indigo
  '#8a6a3e', // ochre
  '#6b4e62', // mauve
  '#5f6b4c', // olive
  '#7a4848', // brick
] as const
