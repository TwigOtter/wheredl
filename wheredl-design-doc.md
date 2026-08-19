# Wheredl — Design Doc

A daily geography guessing game inspired by Wordle/GeoGuessr, built on the ArcGIS Maps SDK for JavaScript.

---

## 1. Overview

- One puzzle per day, shared by all players (Wordle-style, not difficulty-tiered).
- Player sees a locked satellite view of a ~10km x 10km area within a city.
- Player gets 6 guesses on an interactive world map.
- After each guess: geodesic distance feedback (no cardinal direction).
- Score/result is shareable via clipboard, Wordle-style.

---

## 2. Tech Stack

| Layer | Choice |
|---|---|
| Build tool | Vite |
| Mapping | ArcGIS Maps SDK for JavaScript |
| Hosting | GitHub Pages |
| Persistence (V1) | None (stateless per session) |
| Persistence (Phase 2) | `localStorage` (streak, average score) |
| Backend | None |

---

## 3. City Data Source

**Testing phase:**
Random city pulled at runtime from the [World Cities FeatureServer](https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/World_Cities/FeatureServer), filtered by population (starting threshold: **500,000+**, to be tuned via playtesting).

**Release phase:**
- Predetermine a sequence of daily cities.
- Store a static JSON mapping `date -> OBJECTID` (queried against the same Feature Service at load time, not re-hosted).
- No coordinate obfuscation — OID is technically discoverable via dev tools, same honor-system logic as Wordle's answer sitting in the page source. Not worth engineering around.

```json
[
  { "date": "2026-08-24", "objectId": 4821 },
  { "date": "2026-08-25", "objectId": 1932 }
]
```

**Open question:** who/how picks the daily city sequence, and how far in advance? Manual curation ties back into the "distinctive geography" quality concern from the original notes — a script that just walks OIDs in order will hit plenty of forgettable mid-size cities.

---

## 4. Game Flow

1. On load, determine today's date -> look up OBJECTID -> query Feature Service for city geometry + population.
2. Compute a 5km geodesic buffer around the city point via `geometryEngine.geodesicBuffer()`.
3. Render the **Goal MapView** locked to that buffered extent.
4. Player clicks the **Interaction MapView** to place a guess.
5. On each guess:
   - Compute geodesic distance (km) between guess point and city point.
   - Drop a `Graphic` at the guess location, labeled with distance.
   - Append to attempt list/log.
   - If distance < 5km -> treat as a win, end the round (no score contribution from the winning guess itself — see scoring).
6. Round ends when: city is found, or 6 guesses are used.
7. Show result screen: score (or X/6), all guess distances, "Copy Results" button.

---

## 5. MapViews

### 5.1 Goal MapView (locked)
- Basemap: [custom basemap item](https://runtimecoretest.maps.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9).
- Non-interactive (no pan/zoom/rotate).
- Extent set explicitly via the geodesic-buffered geometry's `extent` — **not** by zoom level, to avoid Web Mercator distortion making the "10km square" a different real-world size near the poles vs. the equator.
- Container `<div>` given a **fixed pixel size** (or fixed aspect-ratio + max-width), not a fluid one — this is what actually equalizes the view across devices, since an ultrawide monitor doesn't inherently reveal more area if the container itself doesn't grow.

### 5.2 Interaction MapView
- Same basemap initially; candidate for a vector tile / labeled basemap swap, to be decided via playtesting (labels could make guessing too easy or could just make the UX less frustrating — worth testing both).
- Click handler -> guess point.
- Graphic + label placed per guess showing distance only (no bearing).
- Guess history persists visually across all 6 attempts within the round.

---

## 6. Scoring

**V1 approach: golf-style cumulative log scoring.**

```
points_for_guess = round(ln(distance_km))
```

- Distances under 5km don't get scored — that guess is a win, round ends.
- Max realistic distance ~20,000km -> `ln(20000) ≈ 9.9` -> caps a single bad guess around 10 points, so one wild miss can't blow up the total the way raw linear distance would.
- Total score = sum of `points_for_guess` across all non-winning guesses. Lower is better (golf logic).
- Alternative considered and set aside: GeoGuessr's `5000 * e^(-distance/scale)` decay. Shelved because the "more guesses = potentially higher score" framing didn't sit right for a golf-style system — worth revisiting only if playtesting shows the log curve feels bad in practice.
- Fallback if scoring feels overengineered after playtesting: drop it entirely, go X/6 like Wordle.

**Playtest questions to answer before locking this in:**
- Does `round(ln(x))` feel meaningfully different between a 50km miss and a 500km miss? (`ln(50)≈3.9`, `ln(500)≈6.2` — only ~2.3 points apart, worth sanity-checking against how it *feels* to a player.)
- Does starting a round with a bad first guess feel unrecoverable, or does the log compression make comebacks feel fair?

---

## 7. Sharing / Results

On round completion:
- "Copy Results" button copies a Wordle-style text block to clipboard:
  - Date, score (or X/6), a row of emoji/symbols representing per-guess accuracy tiers (design TBD), and a link to the game.
- No image generation, no server round-trip — pure client-side string built from the guess history already in memory.

---

## 8. UI Layout

### Mobile (stacked)
1. Title: "Wheredl"
2. Goal MapView
3. Interaction MapView
4. Guess list / attempt history

### Desktop (split)
- **Left column:** Title (top) -> Goal MapView -> Guess list
- **Right column:** Interaction MapView

---

## 9. Explicitly Out of Scope for V1

- Accounts / authentication
- Server-side storage of any kind
- Leaderboards
- Puzzle archive
- Difficulty modes (easy/medium/hard) — deliberately rejected in favor of one shared daily puzzle
- `localStorage` streak/average tracking -> **Phase 2**

---

## 10. Open Questions Before Build

1. How is the daily city sequence actually curated/generated, and how far in advance is it committed?
2. Interaction basemap: same as goal view, or swap to something with labels/roads for better UX? (Playtest)
3. Exact scoring formula: log-based golf score vs. X/6 vs. revisit GeoGuessr-style decay. (Playtest)
4. Share-text format/symbols for the clipboard result block.
