import { IteratorChannel, ChannelClosedError, UnsupportedOperationError } from '..';

describe('IterableChannel', () => {
  it('Can take plain iterators', async () => {
    const chan = new IteratorChannel(
      (function* () {
        yield 1;
        yield 2;
        yield 3;
      })()
    );

    expect(await chan.toArray()).toEqual([1, 2, 3]);
  });

  it('Can take async iterators', async () => {
    const chan = new IteratorChannel(
      (async function* () {
        await new Promise((res) => setTimeout(res, 50));
        yield 1;
        await new Promise((res) => setTimeout(res, 50));
        yield 2;
        await new Promise((res) => setTimeout(res, 50));
        yield 3;
      })()
    );

    expect(await chan.toArray()).toEqual([1, 2, 3]);
  });

  it('Can take iterables', async () => {
    const chan = new IteratorChannel(new Set([4, 5, 6]));

    expect(await chan.toArray()).toEqual([4, 5, 6]);
  });

  it('Can be used via the BaseChannel methods', async () => {
    const chan = new IteratorChannel(
      (async function* () {
        yield 1;
      })()
    );

    expect(await chan).toBe(1);
    await expect(chan.get()).rejects.toThrow(ChannelClosedError);
  });

  it('Will emit an error on throw', async () => {
    const chan = new IteratorChannel(
      (async function* () {
        yield 1;
        throw 2;
      })()
    );

    expect(await chan).toBe(1);
    await expect(chan.get()).rejects.toBe(2);
    await expect(chan.get()).rejects.toThrow(ChannelClosedError);
  });

  it('Can queue up multiple receivers', async () => {
    const chan = new IteratorChannel(
      (async function* () {
        yield 1;
        await new Promise((res) => setTimeout(res, 500));
        yield 2;
        yield 3;
      })()
    );

    const res = await Promise.all([chan.get(), chan.get(), chan.get(), chan.get().catch((e) => e.constructor)]);

    expect(res).toEqual([1, 2, 3, ChannelClosedError]);
  });

  it('Can handle being closed between queue & yield', async () => {
    const chan = new IteratorChannel(
      (async function* () {
        yield 1;
        await new Promise((res) => setTimeout(res, 500));
        yield 2;
        fail("Shouldn't reach here");
      })()
    );

    expect(await chan).toBe(1);
    const res = chan.get();
    chan.close();
    await expect(res).rejects.toThrow(ChannelClosedError);
    await expect(chan.get()).rejects.toThrow(ChannelClosedError);
  });

  it('Can be limited in the number of values it takes', async () => {
    const chan = new IteratorChannel(
      (function* () {
        yield 1;
        yield Promise.reject(2);
        fail();
      })(),
      2
    );

    await expect(chan.get()).resolves.toBe(1);
    await expect(chan.get()).rejects.toBe(2);
    await expect(chan.get()).rejects.toThrow(ChannelClosedError);
  });

  it("Can't push, throw, or clear", () => {
    const chan = new IteratorChannel([1, 2, 3]);

    expect(() => chan.push(4)).toThrow(UnsupportedOperationError);
    expect(() => chan.throw(5)).toThrow(UnsupportedOperationError);
    expect(() => chan.clear()).toThrow(UnsupportedOperationError);
  });
});
