# Count the number of peers using the `scrape` feature of torrent trackers

Here's a full example with `browserify`.

```
npm install browserify parse-torrent bittorrent-tracker
```

`scrape.js`:

```js
var Tracker = require('bittorrent-tracker')
var magnet = require('magnet-uri')

// These values don't matter
var peerId = new Buffer('01234567890123456789')
var port = 6889

var magnetURI = "magnet:?xt=urn:btih:6a9759bffd5c0af65319979fb7832189f4f3c35d&dn=sintel.mp4&tr=udp%3A%2F%2Fexodus.desync.com%3A6969&tr=udp%3A%2F%2Ftracker.coppersurfer.tk%3A6969&tr=udp%3A%2F%2Ftracker.internetwarriors.net%3A1337&tr=udp%3A%2F%2Ftracker.leechers-paradise.org%3A6969&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A80&tr=wss%3A%2F%2Ftracker.btorrent.xyz&tr=wss%3A%2F%2Ftracker.fastcast.nz&tr=wss%3A%2F%2Ftracker.openwebtorrent.com&tr=wss%3A%2F%2Ftracker.webtorrent.io&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2Fsintel-1024-surround.mp4"

var parsedTorrent = magnet(magnetURI)
var client = new Tracker(peerId, port, parsedTorrent)

client.scrape()

client.on('scrape', function (data) {
  console.log(data)
})
```

Bundle up `scrape.js` and it's dependencies into a single file called `bundle.js`:

```bash
browserify scrape.js -o bundle.js
```

`index.html`:

```js
<script src="bundle.js"></script>
```

Open `index.html` in your browser.
