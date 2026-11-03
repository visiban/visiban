/**
 * Where a consumer keeps its position, keyed by board id. The client calls
 * `set` only after the consumer's loop body returned for an item, which is
 * what makes delivery at-least-once.
 */
export interface CursorStore {
  get(boardId: number): number | null | undefined | Promise<number | null | undefined>;
  set(boardId: number, cursor: number): void | Promise<void>;
}

/** In-memory default. Lost on restart, so the consumer re-reads from the start. */
export class MemoryCursorStore implements CursorStore {
  private readonly cursors = new Map<number, number>();

  get(boardId: number): number | undefined {
    return this.cursors.get(boardId);
  }

  set(boardId: number, cursor: number): void {
    this.cursors.set(boardId, cursor);
  }
}
