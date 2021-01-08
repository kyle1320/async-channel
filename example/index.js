const { Processor } = require('achan');
const fetch = require('node-fetch');

const urls = [
  'https://www.google.com',
  'https://www.microsoft.com',
  'https://www.apple.com',
  'https://www.amazon.com',
  'https://www.reddit.com',
];

Processor.from(urls) // or Processor.from(someChan)
  .map(fetch, null, 3) // Perform up to 3 requests concurrently
  .filter(
    (res) => res.status === 200, // ignore non-OK status codes
    (err) => false // ignore errors
  )
  .map((res) => res.text())
  .forEach((text) => console.log(text.length));
