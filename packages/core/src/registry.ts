const VALID_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Explicit, in-memory registration of metadata identified by lowercase kebab-case IDs. */
export class Registry<T extends { readonly id: string }> {
  readonly #entries = new Map<string, Readonly<T>>();
  readonly #label: string;

  constructor(label = "Registry") {
    this.#label = label;
  }

  /** Store a frozen shallow snapshot; nested values remain owned by the caller. */
  register(entry: T): void {
    const id = entry?.id;
    this.#validateId(id);
    if (this.#entries.has(id)) {
      throw new Error(`${this.#label} already contains id ${JSON.stringify(id)}.`);
    }

    this.#entries.set(id, Object.freeze({ ...entry, id }));
  }

  get(id: string): Readonly<T> {
    this.#validateId(id);
    const entry = this.#entries.get(id);
    if (entry === undefined) {
      throw new Error(`${this.#label} has no entry with id ${JSON.stringify(id)}.`);
    }
    return entry;
  }

  /** Return a fresh array in registration order. */
  list(): readonly Readonly<T>[] {
    return [...this.#entries.values()];
  }

  #validateId(id: unknown): asserts id is string {
    if (typeof id !== "string" || id !== id.trim() || !VALID_ID.test(id)) {
      const received = typeof id === "string" ? JSON.stringify(id) : String(id);
      throw new TypeError(
        `${this.#label} id must be lowercase kebab-case, starting with a letter; received ${received}.`,
      );
    }
  }
}

/** Metadata registration only; this class does not execute adapters. */
export class AdapterRegistry<T extends { readonly id: string }> extends Registry<T> {
  constructor() {
    super("Adapter registry");
  }
}
