// Waits for typing to pause, then saves the newest text with when it was typed. A save that fails
// (offline, signed out) keeps its text for the next flush, so nothing typed is dropped; the
// server keeps the newest by `updatedAt`. Electron-free and bridge-free, for the tests.

export const SAVE_DELAY_MS = 800;

type Save = (markdown: string, updatedAt: string) => Promise<unknown>;

export class DebouncedSaver {
  private pending: { markdown: string; updatedAt: string } | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly save: Save,
    private readonly onError: (error: unknown) => void = () => {},
    private readonly delay = SAVE_DELAY_MS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  change(markdown: string): void {
    this.pending = { markdown, updatedAt: this.now().toISOString() };
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.delay);
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer);
    const next = this.pending;
    if (!next) return;
    this.pending = null;
    try {
      await this.save(next.markdown, next.updatedAt);
    } catch (error) {
      // Keep it for the next flush, unless something newer was typed meanwhile.
      this.pending ??= next;
      this.onError(error);
    }
  }

  get unsaved(): boolean {
    return this.pending !== null;
  }
}
