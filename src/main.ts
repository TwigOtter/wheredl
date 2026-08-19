import "./style.css";

import "@arcgis/map-components/components/arcgis-map";
import Basemap from "@arcgis/core/Basemap.js";
import FeatureLayer from "@arcgis/core/layers/FeatureLayer.js";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer.js";
import TileLayer from "@arcgis/core/layers/TileLayer.js";
import Graphic from "@arcgis/core/Graphic.js";
import * as geodesicBufferOperator from "@arcgis/core/geometry/operators/geodesicBufferOperator.js";
import * as geodeticDistanceOperator from "@arcgis/core/geometry/operators/geodeticDistanceOperator.js";
import type MapView from "@arcgis/core/views/MapView.js";
import type Point from "@arcgis/core/geometry/Point.js";
import type Extent from "@arcgis/core/geometry/Extent.js";
import type { ArcgisMap } from "@arcgis/map-components/components/arcgis-map";

const WORLD_CITIES_URL =
  "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/World_Cities/FeatureServer/0";
const WORLD_IMAGERY_URL =
  "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer";
const POPULATION_THRESHOLD = 500_000;
const BUFFER_RADIUS_KM = 5;
const WIN_DISTANCE_KM = 20;
const MAX_GUESSES = 10;
const SCORE_CAP = 10;
const RED_SQUARE = "🟥";
const GREEN_SQUARE = "🟩";

interface City {
  point: Point;
  name: string;
}

const citiesLayer = new FeatureLayer({ url: WORLD_CITIES_URL });

/**
 * A plain tile-service basemap, no ArcGIS item/API key required. Each view
 * needs its own Basemap/TileLayer instance rather than sharing one.
 */
function createWorldImageryBasemap(): Basemap {
  return new Basemap({
    baseLayers: [new TileLayer({ url: WORLD_IMAGERY_URL })],
    title: "World Imagery",
  });
}

async function pickRandomCity(): Promise<City> {
  const objectIds = await citiesLayer.queryObjectIds({
    where: `POP >= ${POPULATION_THRESHOLD}`,
  });

  const objectId = objectIds[Math.floor(Math.random() * objectIds.length)];

  const { features } = await citiesLayer.queryFeatures({
    objectIds: [objectId],
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
 * Visual-only shorthand for a guess's score: red squares for points scored
 * (capped at SCORE_CAP), green squares filling the rest. A win (score null)
 * is all green.
 */
function scoreEmoji(score: number | null): string {
  const redCount = score === null ? 0 : score;
  const greenCount = SCORE_CAP - redCount;
  return RED_SQUARE.repeat(redCount) + GREEN_SQUARE.repeat(greenCount);
}

interface Guess {
  distanceKm: number;
  score: number | null;
}

class Round {
  private readonly city: City;
  private readonly guessesLayer: GraphicsLayer;
  private readonly guessListEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly guesses: Guess[] = [];
  private won = false;
  private revealed = false;

  constructor(
    city: City,
    guessesLayer: GraphicsLayer,
    guessListEl: HTMLElement,
    statusEl: HTMLElement,
  ) {
    this.city = city;
    this.guessesLayer = guessesLayer;
    this.guessListEl = guessListEl;
    this.statusEl = statusEl;
    this.updateStatus();
  }

  get isOver(): boolean {
    return this.won || this.guesses.length >= MAX_GUESSES;
  }

  get totalScore(): number {
    return this.guesses.reduce((sum, guess) => sum + (guess.score ?? 0), 0);
  }

  async submitGuess(point: Point): Promise<void> {
    if (this.isOver) return;

    const distanceKm = await geodesicDistanceKm(point, this.city.point);
    const won = distanceKm < WIN_DISTANCE_KM;
    if (won) this.won = true;

    const score = won ? null : scoreForDistance(distanceKm);
    this.guesses.push({ distanceKm, score });

    this.addGuessGraphic(point, distanceKm);
    this.addGuessRow(score);
    this.updateStatus();
  }

  /** Reveals the city location on the guess map and flies the view to it. */
  revealCity(view: MapView, extent: Extent): void {
    if (this.revealed) return;
    this.revealed = true;

    this.guessesLayer.addMany([
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
    const scoreLine = this.won ? `Score: ${this.totalScore}` : `Score: ${this.totalScore} (X/${MAX_GUESSES})`;
    return [...lines, scoreLine].join("\n");
  }

  private addGuessGraphic(point: Point, distanceKm: number): void {
    this.guessesLayer.addMany([
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

  private addGuessRow(score: number | null): void {
    const row = document.createElement("div");
    row.className = "guess-row";
    row.textContent = scoreEmoji(score);
    this.guessListEl.appendChild(row);
  }

  private updateStatus(): void {
    const guessCount = this.guesses.length;
    if (this.won) {
      this.statusEl.textContent = `You found ${this.city.name} in ${guessCount}/${MAX_GUESSES} guesses! Score: ${this.totalScore}`;
    } else if (guessCount >= MAX_GUESSES) {
      this.statusEl.textContent = `Out of guesses. It was ${this.city.name}. Score: ${this.totalScore}`;
    } else {
      this.statusEl.textContent = `${MAX_GUESSES - guessCount} guesses remaining.`;
    }
  }
}

async function main(): Promise<void> {
  const goalView = document.querySelector<ArcgisMap>("#goal-view");
  const goalViewContainer = document.querySelector<HTMLElement>("#goal-view-container");
  const expandBackdrop = document.querySelector<HTMLElement>("#expand-backdrop");
  const interactionView = document.querySelector<ArcgisMap>("#interaction-view");
  const guessListEl = document.querySelector<HTMLElement>("#guess-list");
  const statusEl = document.querySelector<HTMLElement>("#round-status");
  const copyButton = document.querySelector<HTMLButtonElement>("#copy-results");
  if (
    !goalView ||
    !goalViewContainer ||
    !expandBackdrop ||
    !interactionView ||
    !guessListEl ||
    !statusEl ||
    !copyButton
  ) {
    throw new Error("Required DOM elements not found");
  }

  goalView.basemap = createWorldImageryBasemap();
  interactionView.basemap = createWorldImageryBasemap();
  initGoalViewExpand(goalViewContainer, expandBackdrop);

  const cityPromise = pickRandomCity().then((city) => {
    console.log(`Today's city: ${city.name}`);
    return city;
  });
  const extentPromise = cityPromise.then((city) => computeCityExtent(city.point));

  goalView.addEventListener("arcgisViewReadyChange", async () => {
    goalView.view.extent = await extentPromise;
    disableViewNavigation(goalView.view);
  });

  const guessesLayer = new GraphicsLayer();

  interactionView.addEventListener("arcgisViewReadyChange", async () => {
    interactionView.view.map?.add(guessesLayer);

    const city = await cityPromise;
    const round = new Round(city, guessesLayer, guessListEl, statusEl);

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
