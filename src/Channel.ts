/**
 * Error used to signal that a channel has been closed.
 * This can be detected for graceful handling.
 */
export class ChannelClosedError extends Error {}

/**
 * Error used to signal that a channel has been cleared.
 * This may be thrown to senders who are waiting on the channel.
 */
export class ChannelClearedError extends Error {}

type MaybePromise<T> = T | PromiseLike<T>;

/**
 * A Channel serves as a way to send asynchronous values across concurrent lines of execution.
 */
export class Channel<T> {
  /** List of senders waiting for a receiver / buffer space */
  private _senders: {
    item: Promise<T>;
    resolve: () => unknown;
    reject: (err: any) => unknown;
  }[] = [];

  /** A list of receivers waiting for an item to be sent */
  private _receivers: {
    resolve: (value: MaybePromise<T>) => unknown;
    reject: (err: any) => unknown;
  }[] = [];

  private _onClose!: () => void;
  private _onClosePromise: Promise<void>;

  /** A list of buffered items in the channel */
  private _buffer: Array<Promise<T>> = [];

  /** true if the channel is closed and should no longer accept new items. */
  private _closed = false;

  /**
   * Create a new Channel.
   * @param bufferCapacity The maximum number of items to buffer.
   *   Defaults to 0; i.e. all push()/throw() calls will wait for a matching then() call.
   */
  public constructor(public readonly bufferCapacity = 0) {
    this._onClosePromise = new Promise((res) => (this._onClose = res));
  }

  /**
   * Send a new value over the channel.
   * @param value The value to send, or a Promise resolving to a value.
   * @returns A Promise that resolves when the value has been successfully pushed.
   */
  public push(value: T | PromiseLike<T>): Promise<void> {
    return this._send(Promise.resolve(value));
  }

  /**
   * Throw a new error in the channel. Note that errors are also buffered and subject to buffer capacity.
   * @param value The error to throw.
   * @returns A Promise that resolves when the error has been successfully thrown.
   */
  public throw(error: unknown): Promise<void> {
    return this._send(Promise.reject(error));
  }

  /**
   * Close this channel.
   * @param clear Pass true to clear all buffered items / senders when closing the Channel. Defaults to false.
   */
  public close(clear = false): void {
    if (this.closed) {
      throw new ChannelClosedError();
    }

    this._closed = true;

    if (clear) {
      for (const sender of this._senders) {
        sender.reject(new ChannelClosedError());
      }
      this._senders = [];
      this._buffer = [];
    }

    for (const receiver of this._receivers) {
      receiver.reject(new ChannelClosedError());
    }
    this._receivers = [];

    this._onClose();
  }

  /**
   * Clear the channel of all buffered items.
   * Also throws a `ChannelClearedError` to awaiting senders.
   * Does not close the Channel.
   */
  public clear(): Promise<T>[] {
    for (const sender of this._senders) {
      sender.reject(new ChannelClearedError());
    }
    this._senders = [];

    const res = this._buffer;
    this._buffer = [];

    return res;
  }

  /**
   * Wait for the next value (or error) on this channel.
   * @returns A Promise that resolves/rejects when the next value (or error) on this channel is emitted.
   */
  public get(): Promise<T> {
    if (this.bufferSize > 0) {
      const res = this._buffer.shift()!;

      if (this._senders.length > 0 && this.bufferSize < this.bufferCapacity) {
        const sender = this._senders.shift()!;
        this._buffer.push(sender.item);
        sender.resolve();
      }

      return res;
    }

    if (this._senders.length > 0) {
      const sender = this._senders.shift()!;
      sender.resolve();
      return sender.item;
    }

    if (this.closed) {
      return Promise.reject(new ChannelClosedError());
    }

    return new Promise<T>((resolve, reject) => {
      this._receivers.push({ resolve, reject });
    });
  }

  /**
   * Wait for the next value (or error) on this channel and process it.
   * Shorthand for `chan.get().then(...)`.
   */
  public then<U = T, V = never>(
    onvalue?: ((value: T) => MaybePromise<U>) | undefined | null,
    onerror?: ((error: any) => MaybePromise<V>) | undefined | null
  ): Promise<U | V> {
    return this.get().then(onvalue, onerror);
  }

  /**
   * The number of items currently buffered.
   */
  public get bufferSize(): number {
    return this._buffer.length;
  }

  /**
   * True if this channel is closed and no longer accepts new values.
   */
  public get closed(): boolean {
    return this._closed;
  }

  /**
   * A Promise that will resolve when this Channel is closed.
   */
  public get onClose(): Promise<void> {
    return this._onClosePromise;
  }

  /**
   * Returns true if this channel is closed and contains no buffered items or waiting senders.
   */
  public get done(): boolean {
    return this.closed && this.bufferSize === 0 && this._senders.length === 0;
  }

  /**
   * Enables async iteration over the channel.
   * The iterator will stop and throw on the first error encountered.
   */
  public async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    try {
      while (!this.done) {
        yield await this;
      }
    } catch (e) {
      if (!(e instanceof ChannelClosedError)) {
        throw e;
      }
    }
  }

  /**
   * Throws the given error to all waiting receivers.
   * Useful if you want to interrupt all waiting routines immediately.
   */
  public interrupt(error: unknown): void {
    for (const receiver of this._receivers) {
      receiver.reject(error);
    }
    this._receivers = [];
  }

  /**
   * Send the given Item. Returns a Promise that resolves when sent.
   */
  private _send(item: Promise<T>) {
    item.catch(() => {
      // Prevent Node.js from complaining about unhandled rejections
    });

    if (this.closed) {
      return Promise.reject(new ChannelClosedError());
    }

    if (this._receivers.length > 0) {
      const receiver = this._receivers.shift()!;
      receiver.resolve(item);
      return Promise.resolve();
    }

    if (this.bufferSize < this.bufferCapacity) {
      this._buffer.push(item);
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      this._senders.push({ item, resolve, reject });
    });
  }
}
