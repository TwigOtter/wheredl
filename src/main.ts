import "./style.css";

import "@arcgis/map-components/components/arcgis-map";
import "@arcgis/map-components/components/arcgis-scale-bar";
import Basemap from "@arcgis/core/Basemap.js";
import FeatureLayer from "@arcgis/core/layers/FeatureLayer.js";
import TileLayer from "@arcgis/core/layers/TileLayer.js";
import Graphic from "@arcgis/core/Graphic.js";
import * as geodesicBufferOperator from "@arcgis/core/geometry/operators/geodesicBufferOperator.js";
import * as geodeticDistanceOperator from "@arcgis/core/geometry/operators/geodeticDistanceOperator.js";
import type Collection from "@arcgis/core/core/Collection.js";
import type MapView from "@arcgis/core/views/MapView.js";
import type Point from "@arcgis/core/geometry/Point.js";
import type Extent from "@arcgis/core/geometry/Extent.js";
import type { ArcgisMap } from "@arcgis/map-components/components/arcgis-map";
import { cityObjectIdForDay, todaysDayIndex } from "./dailyCities";
import { getOptions, initOptionsPanel, type GameOptions } from "./options";

const WORLD_CITIES_URL =
  "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/World_Cities/FeatureServer/0";
const WORLD_IMAGERY_URL =
  "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer";
const BUFFER_RADIUS_KM = 5;
const WIN_DISTANCE_KM = 20;
const MAX_GUESSES = 10;
const SCORE_CAP = 10;
const SCORE_ROW_WIDTH = 5;
const RED_SQUARE = "🟥";
const YELLOW_SQUARE = "🟨";
const GREEN_SQUARE = "🟩";
const SCORE_OUT_OF = SCORE_CAP * MAX_GUESSES;

// Playtest-only: "Give Me Another!" picks a random day index in this range
// and stashes it here so a page reload picks it up instead of today's city.
const PLAYTEST_DAY_INDEX_RANGE = 500;
const PLAYTEST_DAY_INDEX_KEY = "wheredl-playtest-day-index";

interface City {
  point: Point;
  name: string;
}

const citiesLayer = new FeatureLayer({ url: WORLD_CITIES_URL });

/**
 * A plain tile-service basemap, no ArcGIS item/API key required. Used by the
 * goal view only — labels there would give the answer away outright, so it
 * stays on bare imagery while the guess map uses the hybrid web map.
 */
function createWorldImageryBasemap(): Basemap {
  return new Basemap({
    baseLayers: [new TileLayer({ url: WORLD_IMAGERY_URL })],
    title: "World Imagery",
  });
}

async function pickCityForDay(dayIndex: number): Promise<City> {
  const { features } = await citiesLayer.queryFeatures({
    objectIds: [cityObjectIdForDay(dayIndex)],
    returnGeometry: true,
    outFields: ["CITY_NAME", "CNTRY_NAME"],
  });

  const [city] = features;
  return {
    point: city.geometry as Point,
    name: `${city.attributes.CITY_NAME}, ${city.attributes.CNTRY_NAME}`,
  };
}

async function computeCityExtent(point: Point): Promise<Extent> {
  if (!geodesicBufferOperator.isLoaded()) {
    await geodesicBufferOperator.load();
  }

  const buffer = geodesicBufferOperator.execute(point, BUFFER_RADIUS_KM, {
    unit: "kilometers",
  });
  const extent = buffer?.extent;
  if (!extent) throw new Error("Failed to compute city buffer");
  return extent;
}

async function geodesicDistanceKm(a: Point, b: Point): Promise<number> {
  if (!geodeticDistanceOperator.isLoaded()) {
    await geodeticDistanceOperator.load();
  }
  return geodeticDistanceOperator.execute(a, b, { unit: "kilometers" });
}

/**
 * Esri's documented pattern for a fully static view: intercept the raw
 * input events rather than relying on constraints, which only clamp
 * zoom/rotation and don't stop panning.
 */
function disableViewNavigation(view: MapView): void {
  const stop = (event: { stopPropagation: () => void }) =>
    event.stopPropagation();

  view.on("drag", stop);
  view.on("mouse-wheel", stop);
  view.on("double-click", stop);
  view.on("key-down", stop);
  view.popupEnabled = false;
}

/**
 * The hybrid web map keeps its place labels in the basemap's reference
 * layers, so the labels option is a visibility flip rather than a basemap
 * swap — swapping would reload tiles and jolt the view mid-round.
 */
async function setBasemapLabelsVisible(
  view: MapView,
  visible: boolean,
): Promise<void> {
  const basemap = view.map?.basemap;
  if (!basemap) return;

  // referenceLayers is only populated once the basemap itself has loaded.
  await basemap.load();
  basemap.referenceLayers.forEach((layer) => {
    layer.visible = visible;
  });
}

/** Tap the goal view to blow it up to a larger overlay; tap again (or the backdrop) to shrink it back. */
function initGoalViewExpand(container: HTMLElement, backdrop: HTMLElement): void {
  const toggle = (): void => {
    const expanded = container.classList.toggle("expanded");
    backdrop.classList.toggle("visible", expanded);
  };

  container.addEventListener("click", toggle);
  backdrop.addEventListener("click", toggle);
}

/**
 * Golf-style scoring: a winning guess (< WIN_DISTANCE_KM) scores nothing,
 * it just ends the round. Capped at SCORE_CAP so one wild miss can't blow
 * up the total.
 */
function scoreForDistance(distanceKm: number): number {
  return Math.min(Math.ceil(distanceKm / 1000), SCORE_CAP);
}

/**
 * Visual-only shorthand for a guess's score, five squares wide: each red
 * square is 2 points, a trailing yellow is 1 point, green fills the rest.
 * A win (score null) is all green.
 */
function scoreEmoji(score: number | null): string {
  const points = score ?? 0;
  const redCount = Math.floor(points / 2);
  const yellowCount = points % 2;
  const greenCount = SCORE_ROW_WIDTH - redCount - yellowCount;
  return (
    RED_SQUARE.repeat(redCount) +
    YELLOW_SQUARE.repeat(yellowCount) +
    GREEN_SQUARE.repeat(greenCount)
  );
}

interface Guess {
  distanceKm: number;
  score: number | null;
}

class Round {
  private readonly city: City;
  private readonly dayIndex: number;
  private readonly guessGraphics: Collection<Graphic>;
  private readonly statusEl: HTMLElement;
  private readonly guesses: Guess[] = [];
  private won = false;
  private revealed = false;

  constructor(
    city: City,
    dayIndex: number,
    guessGraphics: Collection<Graphic>,
    statusEl: HTMLElement,
  ) {
    this.city = city;
    this.dayIndex = dayIndex;
    this.guessGraphics = guessGraphics;
    this.statusEl = statusEl;
    this.updateStatus();
  }

  get isOver(): boolean {
    return this.won || this.guesses.length >= MAX_GUESSES;
  }

  /** Sum of capped per-guess penalties, 0 (best) to SCORE_OUT_OF (worst). */
  get totalScore(): number {
    return this.guesses.reduce((sum, guess) => sum + (guess.score ?? 0), 0);
  }

  /** Player-facing score, SCORE_OUT_OF (best) down to 0 (worst) — higher is better. */
  get displayScore(): number {
    return SCORE_OUT_OF - this.totalScore;
  }

  async submitGuess(point: Point): Promise<void> {
    if (this.isOver) return;

    const distanceKm = await geodesicDistanceKm(point, this.city.point);
    const won = distanceKm < WIN_DISTANCE_KM;
    if (won) this.won = true;

    const score = won ? null : scoreForDistance(distanceKm);
    this.guesses.push({ distanceKm, score });

    this.addGuessGraphic(point, distanceKm);
    this.updateStatus();
  }

  /** Reveals the city location on the guess map and flies the view to it. */
  revealCity(view: MapView, extent: Extent): void {
    if (this.revealed) return;
    this.revealed = true;

    this.guessGraphics.addMany([
      new Graphic({
        geometry: this.city.point,
        symbol: {
          type: "simple-marker",
          style: "diamond",
          color: "red",
          size: 14,
          outline: { color: "white", width: 1 },
        },
      }),
      new Graphic({
        geometry: this.city.point,
        symbol: {
          type: "text",
          text: this.city.name,
          color: "white",
          haloColor: "black",
          haloSize: 1,
          yoffset: -18,
          font: { size: 12, weight: "bold" },
        },
      }),
    ]);

    void view.goTo({ target: extent }, { duration: 5000 });
  }

  buildResultsText(): string {
    const lines = this.guesses.map((guess) => scoreEmoji(guess.score));
    return [
      `Wheredl ${this.dayIndex}`,
      `Score: ${this.displayScore}/${SCORE_OUT_OF}`,
      ...lines,
    ].join("\n");
  }

  private addGuessGraphic(point: Point, distanceKm: number): void {
    this.guessGraphics.addMany([
      new Graphic({
        geometry: point,
        symbol: {
          type: "simple-marker",
          color: "orange",
          outline: { color: "white", width: 1 },
        },
      }),
      new Graphic({
        geometry: point,
        symbol: {
          type: "text",
          text: `${distanceKm.toFixed(1)} km`,
          color: "white",
          haloColor: "black",
          haloSize: 1,
          yoffset: -14,
          font: { size: 10, weight: "bold" },
        },
      }),
    ]);
  }

  private updateStatus(): void {
    const guessCount = this.guesses.length;
    if (this.won) {
      this.statusEl.textContent = `You found ${this.city.name} in ${guessCount}/${MAX_GUESSES} guesses! Score: ${this.displayScore}/${SCORE_OUT_OF}`;
    } else if (guessCount >= MAX_GUESSES) {
      this.statusEl.textContent = `Out of guesses. It was ${this.city.name}. Score: ${this.displayScore}/${SCORE_OUT_OF}`;
    } else {
      this.statusEl.textContent = `${MAX_GUESSES - guessCount} guesses remaining.`;
    }
  }
}

/** The real day index, unless a playtest override was stashed by "Give Me Another!". */
function resolveDayIndex(): number {
  const override = sessionStorage.getItem(PLAYTEST_DAY_INDEX_KEY);
  return override !== null ? Number(override) : todaysDayIndex();
}

async function main(): Promise<void> {
  const titleEl = document.querySelector<HTMLElement>("#title");
  const goalView = document.querySelector<ArcgisMap>("#goal-view");
  const goalViewContainer = document.querySelector<HTMLElement>("#goal-view-container");
  const expandBackdrop = document.querySelector<HTMLElement>("#expand-backdrop");
  const interactionView = document.querySelector<ArcgisMap>("#interaction-view");
  const scaleBar = document.querySelector<HTMLElement>("#interaction-scale-bar");
  const statusEl = document.querySelector<HTMLElement>("#round-status");
  const copyButton = document.querySelector<HTMLButtonElement>("#copy-results");
  const giveAnotherButton = document.querySelector<HTMLButtonElement>("#give-another");
  if (
    !titleEl ||
    !goalView ||
    !goalViewContainer ||
    !expandBackdrop ||
    !interactionView ||
    !scaleBar ||
    !statusEl ||
    !copyButton ||
    !giveAnotherButton
  ) {
    throw new Error("Required DOM elements not found");
  }

  // The interaction view's basemap comes from the hybrid web map item set in
  // index.html, so only the goal view needs one built here.
  goalView.basemap = createWorldImageryBasemap();
  initGoalViewExpand(goalViewContainer, expandBackdrop);

  const applyOptions = (options: GameOptions): void => {
    scaleBar.hidden = !options.scaleBar;
    if (interactionView.ready) {
      void setBasemapLabelsVisible(interactionView.view, options.labels);
    }
  };

  initOptionsPanel(applyOptions);
  applyOptions(getOptions());

  giveAnotherButton.addEventListener("click", () => {
    const randomDayIndex = Math.floor(Math.random() * PLAYTEST_DAY_INDEX_RANGE);
    sessionStorage.setItem(PLAYTEST_DAY_INDEX_KEY, String(randomDayIndex));
    location.reload();
  });

  const dayIndex = resolveDayIndex();
  titleEl.textContent = `Wheredl #${dayIndex}`;

  const cityPromise = pickCityForDay(dayIndex).then((city) => {
    console.log(`Today's city: ${city.name}`);
    return city;
  });
  const extentPromise = cityPromise.then((city) => computeCityExtent(city.point));

  goalView.addEventListener("arcgisViewReadyChange", async () => {
    goalView.view.extent = await extentPromise;
    disableViewNavigation(goalView.view);
  });

  // If the web map item can't be fetched, fall back to the plain imagery
  // basemap so the round is still playable — just without labels. Strictly
  // one-shot: the event fires again for every layer that fails to load, so
  // retrying would spin up a fresh basemap on each one.
  let usedBasemapFallback = false;
  interactionView.addEventListener("arcgisLoadError", () => {
    if (usedBasemapFallback) return;
    usedBasemapFallback = true;

    console.warn(
      "Hybrid web map failed to load, falling back to plain imagery",
      interactionView.loadErrorSources,
    );
    interactionView.itemId = null;
    interactionView.basemap = createWorldImageryBasemap();
  });

  let roundStarted = false;

  interactionView.addEventListener("arcgisViewReadyChange", async () => {
    // Also fires on the ready -> not-ready transition.
    if (!interactionView.ready) return;

    void setBasemapLabelsVisible(interactionView.view, getOptions().labels);

    // The round itself is wired exactly once — a second pass would register
    // a second click handler and double-count every guess.
    if (roundStarted) return;
    roundStarted = true;

    const city = await cityPromise;
    // Guesses go in the view's graphics collection rather than a
    // GraphicsLayer: the basemap's reference layer (place labels) draws above
    // every layer in the map, so a GraphicsLayer's markers end up buried under
    // the labels. This collection sits above all of it, and belongs to the
    // view rather than the map, so a basemap swap can't disturb it.
    const round = new Round(city, dayIndex, interactionView.graphics, statusEl);

    interactionView.view.on("click", (event) => {
      if (round.isOver) return;
      void round.submitGuess(event.mapPoint).then(async () => {
        if (!round.isOver) return;
        copyButton.hidden = false;
        round.revealCity(interactionView.view, await extentPromise);
      });
    });

    copyButton.addEventListener("click", async () => {
      await navigator.clipboard.writeText(round.buildResultsText());
      const originalLabel = copyButton.textContent;
      copyButton.textContent = "Copied!";
      setTimeout(() => {
        copyButton.textContent = originalLabel;
      }, 1500);
    });
  });
}

main();
