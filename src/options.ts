/**
 * Playtest options. Both helpers are aids for the "I can't tell how big
 * anything is / I can't find anything" feedback, so they're on by default
 * and players can turn them off to compare.
 */
export interface GameOptions {
  /** Scale bar in the corner of the guess map. */
  scaleBar: boolean;
  /** Place labels (the hybrid basemap's reference layers) on the guess map. */
  labels: boolean;
}

const STORAGE_KEY = "wheredl-options";
const DEFAULT_OPTIONS: GameOptions = { scaleBar: true, labels: true };

let options: GameOptions = readStoredOptions();

/**
 * Preferences have to survive the reload that "Give Me Another!" triggers,
 * so they live in localStorage. Storage can throw outright (Safari private
 * browsing), and a corrupt value shouldn't take the game down with it, so
 * every access falls back to the defaults.
 */
function readStoredOptions(): GameOptions {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return { ...DEFAULT_OPTIONS };
    const parsed = JSON.parse(stored) as Partial<GameOptions>;
    return {
      scaleBar: parsed.scaleBar ?? DEFAULT_OPTIONS.scaleBar,
      labels: parsed.labels ?? DEFAULT_OPTIONS.labels,
    };
  } catch {
    return { ...DEFAULT_OPTIONS };
  }
}

function writeStoredOptions(next: GameOptions): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Non-fatal: the options just won't survive a reload.
  }
}

export function getOptions(): GameOptions {
  return options;
}

/**
 * Wires the Options button, its dialog, and the checkboxes inside it.
 * `onChange` fires on every toggle (and never on open/close), always with
 * the full current option set.
 */
export function initOptionsPanel(onChange: (options: GameOptions) => void): void {
  const openButton = document.querySelector<HTMLButtonElement>("#options-button");
  const dialog = document.querySelector<HTMLDialogElement>("#options-dialog");
  const closeButton = document.querySelector<HTMLButtonElement>("#options-close");
  const scaleBarInput = document.querySelector<HTMLInputElement>("#option-scale-bar");
  const labelsInput = document.querySelector<HTMLInputElement>("#option-labels");
  if (!openButton || !dialog || !closeButton || !scaleBarInput || !labelsInput) {
    throw new Error("Options panel elements not found");
  }

  scaleBarInput.checked = options.scaleBar;
  labelsInput.checked = options.labels;

  const update = (patch: Partial<GameOptions>): void => {
    options = { ...options, ...patch };
    writeStoredOptions(options);
    onChange(options);
  };

  scaleBarInput.addEventListener("change", () => {
    update({ scaleBar: scaleBarInput.checked });
  });
  labelsInput.addEventListener("change", () => {
    update({ labels: labelsInput.checked });
  });

  openButton.addEventListener("click", () => dialog.showModal());
  closeButton.addEventListener("click", () => dialog.close());
  // A modal dialog's backdrop is part of the dialog element itself, so a
  // click that lands on the dialog rather than its content is a click outside.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
}
