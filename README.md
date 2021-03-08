# async-channel: JavaScript Async Channels

![CI Pipeline](https://github.com/kyle1320/async-channel/workflows/CI%20Pipeline/badge.svg)
[![Coverage Status](https://coveralls.io/repos/github/kyle1320/async-channel/badge.svg?branch=main)](https://coveralls.io/github/kyle1320/async-channel?branch=main)
[![npm](https://img.shields.io/npm/v/async-channel)](https://www.npmjs.com/package/async-channel)
![license](https://img.shields.io/npm/l/async-channel)
![npm bundle size](https://img.shields.io/bundlephobia/minzip/async-channel)

async-channel provides iterable, `await`able Channels for passing asynchronous values around, as well as tools for utilizing these Channels to perform parallel processing using a simple, functional API.

Zero dependencies, well-tested and works in all environments supporting ES6.

Reminiscent of Go channels (but don't let that distract you -- there are several differences).

## Documentation

Detailed API Documentation can be found [here](https://kyle1320.github.io/async-channel/).

## Basic Usage

Create a Channel, passing an optional buffer capacity:

```js
const chan = new Channel(0 /* default */);
```

Now do some asynchronous processing. For example:

```js
const urls = [
    "https://www.google.com",
    "https://www.microsoft.com",
    "https://www.apple.com",
    // ...
];

for (const url of urls) {
    fetch(url).then(response => {
        const text = response.text();

        // push the response body to the channel
        chan.push(text);
    });
}
```

This will fetch each URL and send the body of each response over the Channel when complete. Here, `text` is a Promise, but plain values can be pushed to a Channel as well.

Now all that's left to do is receive each result from the Channel:

```js
do {
    const text = await chan;
    console.log(text);
} while (!chan.done);
```

This can be written more succintly using async iteration:

```js
for await (const text of chan) {
    console.log(text);
}
```

This is a simple example -- there are many more ways to use Channels.

### Channel Closing

Closing a Channel is often not necessary. However it can be useful if a downstream receiver needs to know when all values have been sent to the channel. It is also necessary for async iteration to complete. In the above example, the loops will never terminate as the Channel is never closed.

`chan.close()` closes the channel, preventing further values from being sent. However, any buffered values or queued senders will remain on the Channel and continue to be processed.

When all values have been received from the channel, it is considered "done" (`chan.done` will be `true`). At this point, any additional receivers will be rejected with a `ChannelClosedError`. If you are manually iterating over the Channel, you may want to handle this error gracefully (async iteration handles this automatically).

### Error Handling

Just as Promises can either resolve or reject, each item in a Channel can either be a value or an error.

Promises passed to `chan.push()` will result in an error on the Channel if they reject. In addition, `chan.throw(err)` can be used to send an error over the Channel.

Async iteration over a Channel will stop when an error is encountered. Otherwise, errors are treated the same as normal values -- an error will not close, empty, or otherwise adversely affect the state of a Channel.

### Receive a Single Value

Use `chan.get()` to receive a single value from a Channel. This method returns a Promise that resolves or rejects with the next value or error on the Channel:

```js
chan.get().then(
    value => console.log(value),
    error => console.error(error)
);
```

Channels also have a shorthand `then()` method that is compatible with Promises and `async`/`await` syntax, so the above can also be written as:

```js
try {
    const text = await chan;
    console.log(text);
} catch (err) {
    console.error(err);
}
```

### Waiting for Consumption

In the above example, we simply send a value to the channel and forget about it. But sometimes it is useful to wait for the value to be received before proceeding (if you're familiar with Go channels, this should make sense to you).

For these scenarios, `chan.push()` and `chan.throw()` return a Promise that resolves when the value has been accepted by the Channel -- either when it has been inserted into the Channel's buffer (if the buffer capacity is not 0), or when it has been received.

### Multiple Receivers

If multiple receivers are pulling from the same Channel, only one will receive each item. This can be useful to create multiple "worker threads" (or coroutines) that receive and process values from a channel, and then push them into a result channel.

## Functional Utility Methods

In fact, this multi-receiver pattern is so useful that Channels have several methods for performing "multi-threaded" functional operations such as `map` and `filter` over their values, while utilizing concurrency. For example:

```js
  Channel.from(urls)               // or any Channel
    .map(fetch, null, 3)           // Perform up to 3 requests concurrently
    .filter(
        res => res.status === 200, // ignore non-OK status codes
        err => false               // ignore errors
    )
    .map(res => res.text())
    .forEach(text => console.log(text));
```

This is similar to the above example, but limits the number of simultaneous requests to 3, and returns a Promise that resolves after all processing has been completed.

## `BaseChannel` class

If you are only using Channels for basic communication (without any of the functional methods or iterators), you can just use the `BaseChannel` class. This can be useful for tree-shaking the unused code.

## `IteratorChannel` Class

It can be useful to create a Channel which simply pulls its values from an iterable source. This is most useful for scenarios like the above example, where the input elements are pre-defined or easily generated