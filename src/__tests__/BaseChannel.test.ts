import { BaseChannel, ChannelClearedError, ChannelClosedError } from '..';

describe('Channel', () => {
  describe('Buffered Channel', () => {
    it('Holds up to N values', async () => {
      const chan = new BaseChannel(3);

      await chan.push(1);
      await chan.push(2);
      await chan.push(3);

      const promise = chan.push(4);
      await expect(Promise.race([promise, Promise.reject(null)])).rejects.toBe(null);

      expect(chan.bufferCapacity).toBe(3);
      expect(chan.bufferSize).toBe(3);

      await expect(chan.get()).resolves.toBe(1);
      await expect(promise).resolves.toBeUndefined();
    });

    it("Doesn't buffer if a receiver is waiting", async () => {
      const chan = new BaseChannel(3);

      await chan.push(1);
      await expect(chan.get()).resolves.toBe(1);

      const promise = chan.get();

      await chan.push(2);
      expect(chan.bufferSize).toBe(0);
      expect(promise).resolves.toBe(2);
    });

    it('Continues holding values when closed', async () => {
      const chan = new BaseChannel(3);

      const promises = [chan.push(0), chan.push(1), chan.push(2), chan.push(3), chan.push(4)];

      expect(chan.bufferSize).toBe(3);

      chan.close();

      expect(chan.closed).toBe(true);
      expect(chan.done).toBe(false);
      expect(chan.bufferSize).toBe(3);

      for (let i = 0; i < 5; i++) {
        await expect(chan.get()).resolves.toBe(i);
        await expect(promises[i]).resolves.toBeUndefined();
      }

      expect(chan.done).toBe(true);
    });

    it('close(true) clears all values and senders', async () => {
      const chan = new BaseChannel(3);

      const promises = [chan.push(0), chan.push(1), chan.push(2), chan.push(3), chan.push(4)];

      expect(chan.bufferSize).toBe(3);

      chan.close(true);

      expect(chan.closed).toBe(true);
      expect(chan.done).toBe(true);
      expect(chan.bufferSize).toBe(0);

      for (let i = 0; i < 5; i++) {
        if (i < 3) {
          await expect(promises[i]).resolves.toBeUndefined();
        } else {
          await expect(promises[i]).rejects.toBeInstanceOf(ChannelClosedError);
        }
      }

      await expect(chan.push(9)).rejects.toBeInstanceOf(ChannelClosedError);
      await expect(chan.get()).rejects.toBeInstanceOf(ChannelClosedError);
      await expect(() => chan.close()).toThrowError(ChannelClosedError);
    });

    it('Buffer can be cleared', async () => {
      const chan = new BaseChannel(3);

      const promises = [chan.push(0), chan.push(1), chan.push(2), chan.push(3), chan.push(4)];

      expect(chan.bufferSize).toBe(3);

      chan.clear();

      expect(chan.bufferSize).toBe(0);

      for (let i = 0; i < 5; i++) {
        if (i < 3) {
          await expect(promises[i]).resolves.toBeUndefined();
        } else {
          await expect(promises[i]).rejects.toBeInstanceOf(ChannelClearedError);
        }
      }

      const promise = chan.get();
      chan.push(9);
      await expect(promise).resolves.toBe(9);
    });

    it('Can buffer errors', async () => {
      const chan = new BaseChannel(3);

      const promises = [chan.throw(0), chan.throw(1), chan.throw(2), chan.throw(3), chan.throw(4)];

      expect(chan.bufferSize).toBe(3);

      for (let i = 0; i < 5; i++) {
        await expect(chan.get()).rejects.toBe(i);
        await expect(promises[i]).resolves.toBeUndefined();
      }
    });
  });

  describe('Unbuffered Channel', () => {
    it('then() works as expected', async () => {
      const chan = new BaseChannel<number>();

      const promise = chan.then((x) => x * 2);
      await chan.push(3);
      await expect(promise).resolves.toBe(6);

      const promise2 = chan.then(
        (x) => x + 1,
        (x) => x - 1
      );
      await chan.throw(10);
      await expect(promise2).resolves.toBe(9);

      chan.push(5);
      expect(await chan).toBe(5);

      chan.throw(7);
      try {
        await chan;
        fail('Expected an error');
      } catch (e) {
        expect(e).toBe(7);
      }
    });

    it('Promise flattening works as expected', async () => {
      const chan = new BaseChannel();

      const promises = [
        chan.push(Promise.resolve(0)),
        chan.push(Promise.resolve(1)),
        chan.push(2),
        chan.push(Promise.reject(3)),
        chan.throw(4),
      ];

      for (let i = 0; i < 5; i++) {
        if (i < 3) {
          await expect(chan.get()).resolves.toBe(i);
        } else {
          await expect(chan.get()).rejects.toBe(i);
        }
        await expect(promises[i]).resolves.toBeUndefined();
      }
    });

    it('Stops async iteration when an error is encountered', async () => {
      const chan = new BaseChannel();

      const promises = [chan.push(0), chan.push(1), chan.push(2), chan.push(3), chan.throw(4), chan.push(5)];

      expect(chan.bufferSize).toBe(0);

      let i = 0;
      try {
        for await (const value of chan) {
          expect(value).toBe(i);
          expect(promises[i]).resolves.toBeUndefined();
          i++;
        }
        fail('Expected an error');
      } catch (e) {
        expect(e).toBe(i);
        expect(promises[i]).resolves.toBeUndefined();
      }

      i++;
      await expect(chan.get()).resolves.toBe(i);
      await expect(promises[i]).resolves.toBeUndefined();
    });

    it('Continues waiting on senders when closed', async () => {
      const chan = new BaseChannel();

      const promises = [chan.push(0), chan.push(1), chan.push(2), chan.push(3), chan.push(4)];

      expect(chan.bufferSize).toBe(0);

      chan.close();

      expect(chan.closed).toBe(true);
      expect(chan.done).toBe(false);
      expect(chan.bufferSize).toBe(0);

      for (let i = 0; i < 5; i++) {
        await expect(chan.get()).resolves.toBe(i);
        await expect(promises[i]).resolves.toBeUndefined();
      }

      expect(chan.done).toBe(true);
    });

    it('Async iteration stops normally when closed', async () => {
      const chan = new BaseChannel();

      const iterator = (async () => {
        let i = 0;
        for await (const value of chan) {
          expect(value).toBe(i);
          i++;
        }
        expect(chan.done).toBe(true);
      })();

      await chan.push(0);
      await chan.push(1);
      await chan.push(2);
      await chan.push(3);

      // Give the iterator time to finish.
      // This tests the case where the iterator is already waiting on a value when the channel closes.
      await new Promise((res) => setTimeout(res, 10));

      chan.close();

      await iterator;
    });

    it('Throws as error to receivers on close', async () => {
      const chan = new BaseChannel();

      const receivers = [chan.get(), chan.get()];

      chan.close();

      for (const receiver of receivers) {
        await expect(receiver).rejects.toBeInstanceOf(ChannelClosedError);
      }
    });

    it('Can interrupt receivers', async () => {
      const chan = new BaseChannel();

      const awaiters = [chan.get(), chan.get()];

      chan.interrupt('fail');

      for (const promise of awaiters) {
        await expect(promise).rejects.toBe('fail');
      }

      chan.push(1);

      await expect(chan.get()).resolves.toBe(1);
    });
  });

  it('Push and pull simultaneously', async () => {
    const chan = new BaseChannel<number>();
    chan.push(1);

    // Generate Fibonacci values
    let prev = 0;
    for await (const val of chan) {
      chan.push(val + prev);
      prev = val;

      if (val > 20) break;
    }

    const last = await chan;
    expect(last).toBe(34);
  });
});
