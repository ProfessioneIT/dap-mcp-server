export class RingBuffer<T> {
  private buffer: T[] = [];
  private maxSize: number;
  private _truncated = false;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  push(item: T): void {
    if (this.buffer.length >= this.maxSize) {
      this.buffer.shift();
      this._truncated = true;
    }
    this.buffer.push(item);
  }

  getAll(): T[] {
    return [...this.buffer];
  }

  getFiltered(predicate: (item: T) => boolean): T[] {
    return this.buffer.filter(predicate);
  }

  clear(): void {
    this.buffer = [];
    this._truncated = false;
  }

  removeMatching(predicate: (item: T) => boolean): void {
    this.buffer = this.buffer.filter((item) => !predicate(item));
  }

  get size(): number {
    return this.buffer.length;
  }

  get truncated(): boolean {
    return this._truncated;
  }
}
