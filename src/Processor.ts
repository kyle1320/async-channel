import { Channel, ChannelClosedError } from './Channel';

type MaybePromise<T> = T | PromiseLike<T>;

/**
 * A Processor is a lightweight wrapper around a Channel
 * which provides common operations like `map`, `filter`, `toArray`, etc.
 */
export class Processor<T> {
  private constructor(private readonly _chan: Channel<T>) {}

  /**
   * Creates a new Processor from a given source.
   * If the source is a Channel, that Channel's values will be consumed by the Processor.
   * Otherwise a new Channel will be created from values in the source.
   * @param values Either a Channel or an Array-like object containing values to be processed.
   */
  public static from<T>(source: ArrayLike<MaybePromise<T>> | Iterable<MaybePromise<T>> | Channel<T>): Processor<T> {
    if (source instanceof Channel) {
      return new Processor(source);
    } else {
      return Processor.of(...Array.from(source));
    }
  }

  /**
   * Creates a new Processor for the given values.
   * A new Channel will be created with these values.
   * @param values A list of values to be processed. These may be Promises, in which case they will be flattened.
   */
  public static of<T>(...values: MaybePromise<T>[]): Processor<T> {
    const chan = new Channel<T>(values.length);

    for (const value of values) {
      chan.push(value);
    }
    chan.close();

    return new Processor(chan);
  }

  /**
   * Gets this Processor's Channel.
   */
  public get channel(): Channel<T> {
    return this._chan;
  }

  /**
   * Applies a transformation function, applying the transformation to this Processor until it is empty and
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
  ): Processor<U> {
    const output: Channel<U> = new Channel(bufferCapacity);

    this._consume(async (chan) => {
      try {
        await func(chan, output);
      } catch (e) {
        if (!(e instanceof ChannelClosedError)) output.throw(e);
      }
    }, concurrency).then(() => output.close());

    return new Processor(output);
  }

  /**
   * Applies the given 1-to-1 mapping function to this Processor and returns a new Processor with the mapped values.
   * @param onvalue A function that maps values from this Processor.
   *   To map to an error, either throw or return a rejecting Promise.
   *   May return a Promise or a plain value. If omitted, values will be propagated as-is.
   * @param onerror A function that maps errors from this Processor to *values*.
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
  ): Processor<U | V> {
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
   * Applies the given filter function to the values from this Processor and returns a new Processor with only the filtered values.
   * @param onvalue A function that takes a value from this Processor and returns a boolean of whether to include the value in the resulting Processor.
   *   May return a Promise or a plain value. Defaults to passing all values.
   * @param onerror A function that takes an error from this Processor and returns a boolean of whether to include the error in the resulting Processor.
   *   May return a Promise or a plain value. Defaults to passing all values.
   * @param concurrency The number of "coroutines" to spawn to perform this operation. Must be positive and finite. Defaults to 1.
   * @param bufferCapacity The buffer size of the output channel. Defaults to 0.
   */
  public filter(
    onvalue?: ((value: T) => MaybePromise<boolean>) | undefined | null,
    onerror?: ((error: any) => MaybePromise<boolean>) | undefined | null,
    concurrency?: number,
    bufferCapacity?: number
  ): Processor<T> {
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
   * Consumes each value from this Processor, applying the given function on each. Errors on the Channel or in the function will cause the returned Promise to reject.
   * @param onvalue A function to invoke with each value from this Processor.
   * @param onerror A function to invoke with each error from this Processor.
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
   * Consumes the values in this Processor and inserts them into an Array.
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
          while (!this._chan.done) {
            await consumer(this._chan);
          }
        })()
      );
    }

    return Promise.all(promises).then();
  }
}
