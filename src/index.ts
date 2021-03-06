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
 * A BaseChannel serves as a way to send asynchronous values across concurrent lines of execution.
 */
export class BaseChannel<T> {
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

/**
 * A Channel extends BaseChannel and provides additional functionality for performing concurrent processing.
 */
export class Channel<T> extends BaseChannel<T> {
  /**
   * Creates a new Channel from a given source.
   * @param values An Array-like or iterable object containing values to be processed.
   */
  public static from<T>(source: ArrayLike<MaybePromise<T>> | Iterable<MaybePromise<T>>): Channel<T> {
    return Channel.of(...Array.from(source));
  }

  /**
   * Creates a new Channel for the given values.
   * A new Channel will be created with these values.
   * @param values A list of values to be processed. These may be Promises, in which case they will be flattened.
   */
  public static of<T>(...values: MaybePromise<T>[]): Channel<T> {
    const chan = new Channel<T>(values.length);

    for (const value of values) {
      chan.push(value);
    }
    chan.close();

    return chan;
  }

  /**
   * Applies a transformation function, applying the transformation to this Channel until it is empty and
   * @param func The transformation function.
   *   This function may read from the given input channel and write to the given output channel as desired.
   *   Because this function should at minimum read from the input channel, and possibly write to the output channel, it should return a Promise in order for concurrency limits to be obeyed.
   * @param concurrency The number of "coroutines" to spawn to perform this operation. Must be positive and finite. Defaults to 1.
   * @param bufferCapacity The buffer size of the output channel. Defaults to 0.
   */
  public transform<U>(
    func: (input: Channel<T>, output: Channel<U>) => Promise<void>,
    concurrency?: number,
    bufferCapacity?: number
  ): Channel<U> {
    const output: Channel<U> = new Channel(bufferCapacity);

    this._consume(async (chan) => {
      try {
        await func(chan, output);
      } catch (e) {
        if (!(e instanceof ChannelClosedError)) output.throw(e);
      }
    }, concurrency).then(() => output.close());

    return output;
  }

  /**
   * Applies the given 1-to-1 mapping function to this Channel and returns a new Channel with the mapped values.
   * @param onvalue A function that maps values from this Channel.
   *   To map to an error, either throw or return a rejecting Promise.
   *   May return a Promise or a plain value. If omitted, values will be propagated as-is.
   * @param onerror A function that maps errors from this Channel to *values*.
   *   To map to an error, either throw or return a rejecting Promise.
   *   May return a Promise or a plain value. If omitted, errors will be propagated as-is.
   * @param concurrency The number of "coroutines" to spawn to perform this operation. Must be positive and finite. Defaults to 1.
   * @param bufferCapacity The buffer size of the output channel. Defaults to 0.
   */
  public map<U = T, V = never>(
    onvalue?: ((value: T) => MaybePromise<U>) | undefined | null,
    onerror?: ((error: any) => MaybePromise<V>) | undefined | null,
    concurrency?: number,
    bufferCapacity?: number
  ): Channel<U | V> {
    return this.transform(
      (input, output) =>
        input.then(
          onvalue && (async (value) => output.push(await onvalue(value))),
          onerror &&
            (async (error) => {
              if (!(error instanceof ChannelClosedError)) {
                output.push(await onerror(error));
              }
            })
        ),
      concurrency,
      bufferCapacity
    );
  }

  /**
   * Applies the given filter function to the values from this Channel and returns a new Channel with only the filtered values.
   * @param onvalue A function that takes a value from this Channel and returns a boolean of whether to include the value in the resulting Channel.
   *   May return a Promise or a plain value. Defaults to passing all values.
   * @param onerror A function that takes an error from this Channel and returns a boolean of whether to include the error in the resulting Channel.
   *   May return a Promise or a plain value. Defaults to passing all values.
   * @param concurrency The number of "coroutines" to spawn to perform this operation. Must be positive and finite. Defaults to 1.
   * @param bufferCapacity The buffer size of the output channel. Defaults to 0.
   */
  public filter(
    onvalue?: ((value: T) => MaybePromise<boolean>) | undefined | null,
    onerror?: ((error: any) => MaybePromise<boolean>) | undefined | null,
    concurrency?: number,
    bufferCapacity?: number
  ): Channel<T> {
    return this.transform(
      (input, output) => {
        return input.then(
          onvalue &&
            (async (value) => {
              if (await onvalue(value)) {
                await output.push(value);
              }
            }),
          onerror &&
            (async (err) => {
              if (!(err instanceof ChannelClosedError) && (await onerror(err))) {
                await output.throw(err);
              }
            })
        );
      },
      concurrency,
      bufferCapacity
    );
  }

  /**
   * Consumes each value from this Channel, applying the given function on each. Errors on the Channel or in the function will cause the returned Promise to reject.
   * @param onvalue A function to invoke with each value from this Channel.
   * @param onerror A function to invoke with each error from this Channel.
   * @param concurrency The number of "coroutines" to spawn to perform this operation. Must be positive and finite. Defaults to 1.
   * @returns A Promise that resolves when all values have been consumed, or rejects when an error is received from the Channel.
   */
  public forEach(
    onvalue?: ((value: T) => unknown) | undefined | null,
    onerror?: ((error: any) => unknown) | undefined | null,
    concurrency?: number
  ): Promise<void> {
    // if one error is unhandled, all coroutines should stop processing.
    let didThrow = false;
    let thrownError: unknown;

    return this._consume(async (chan) => {
      if (didThrow) {
        throw thrownError;
      }

      await chan
        .then(onvalue, (e) => {
          if (e instanceof ChannelClosedError) {
            return;
          }

          if (!didThrow && onerror) {
            return onerror(e);
          }

          throw e;
        })
        .catch((e) => {
          if (!didThrow) {
            didThrow = true;
            thrownError = e;
            chan.interrupt(e);
          }
          throw e;
        });
    }, concurrency);
  }

  /**
   * Consumes the values in this Channel and inserts them into an Array.
   * Returns a Promise that resolves to that Array if no errors were emitted.
   */
  public async toArray(): Promise<T[]> {
    const result: T[] = [];

    await this.forEach((value) => result.push(value));

    return result;
  }

  /**
   * General function for applying a consumer function with multiple "coroutines" until the Channel is done.
   * Also handles errors by stopping all routines.
   */
  private _consume(consumer: (chan: Channel<T>) => Promise<void>, concurrency = 1): Promise<void> {
    if (concurrency <= 0 || !isFinite(concurrency)) {
      throw new RangeError('Value for concurrency must be positive and finite');
    }

    const promises: Promise<void>[] = [];

    for (let i = 0; i < concurrency; i++) {
      promises.push(
        (async () => {
          while (!this.done) {
            await consumer(this);
          }
        })()
      );
    }

    return Promise.all(promises).then();
  }
}
