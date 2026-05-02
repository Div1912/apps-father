// Home page data — list of "apps" the agent has built / is building
window.APPS_DATA = [
  { id: "english_puzzle", name: "English Puzzle", handle: "@english_puzzle_bot", color: "#2EBD9F", initials: "EP", status: "ready" },
  { id: "new_app_1", name: "New App", handle: "", color: "#F4A23A", initials: "NA", status: "ready" },
  { id: "new_app_2", name: "New App", handle: "", color: "#F4A23A", initials: "NA", status: "created" },
  { id: "new_app_3", name: "New App", handle: "", color: "#F4A23A", initials: "NA", status: "released" },
  { id: "new_app_4", name: "New App", handle: "", color: "#F4A23A", initials: "NA", status: "released" },
  { id: "swipe", name: "Swipe", handle: "@swipe_card_bot", color: "#3B3B3B", initials: "→", status: "planning" },
  { id: "bomb", name: "Bomb", handle: "@k1ng_official_bot", color: "#C53030", initials: "💣", status: "released" },
  { id: "counter_strike", name: "Counter Strike 3D", handle: "@counter_strikesbot", color: "#1a1a1a", initials: "◎", status: "ready" },
  { id: "neon_runner", name: "Neon Runner", handle: "@neon_runner_bot", color: "#7C3AED", initials: "NR", status: "building" },
  { id: "chess_ai", name: "Chess AI", handle: "@chess_ai_bot", color: "#0F766E", initials: "♞", status: "released" },
];

window.STATUS_META = {
  ready: { label: "Ready", color: "#F59E0B" },
  created: { label: "Created", color: "#9CA3AF" },
  released: { label: "Released", color: "#22C55E" },
  planning: { label: "Planning", color: "#9CA3AF" },
  building: { label: "Building", color: "oklch(0.68 0.19 230)" },
};
