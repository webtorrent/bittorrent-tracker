# bittorrent-tracker [![travis][travis-image]][travis-url] [![npm][npm-image]][npm-url] [![downloads][downloads-image]][downloads-url]

[travis-image]: https://img.shields.io/travis/feross/bittorrent-tracker/master.svg
[travis-url]: https://travis-ci.org/feross/bittorrent-tracker
[npm-image]: https://img.shields.io/npm/v/bittorrent-tracker.svg
[npm-url]: https://npmjs.org/package/bittorrent-tracker
[downloads-image]: https://img.shields.io/npm/dm/bittorrent-tracker.svg
[downloads-url]: https://npmjs.org/package/bittorrent-tracker

#### Simple, robust, BitTorrent tracker (client & server) implementation

![tracker](https://raw.githubusercontent.com/feross/bittorrent-tracker/master/img.png)

Node.js implementation of a [BitTorrent tracker](https://wiki.theory.org/BitTorrentSpecification#Tracker_HTTP.2FHTTPS_Protocol), client and server.

A **BitTorrent tracker** is an web service which responds to requests from BitTorrent
clients. The requests include metrics from clients that help the tracker keep overall
statistics about the torrent. The response includes a peer list that helps the client
participate in the torrent swarm.

This module is used by [WebTorrent](http://webtorrent.io).

## features

- Includes client & server implementations
- Supports all mainstream tracker types:
  - HTTP trackers
  - UDP trackers ([BEP 15](http://www.bittorrent.org/beps/bep_0015.html))
  - WebTorrent trackers ([BEP forthcoming](http://webtorrent.io))
- Supports ipv4 & ipv6
- Supports tracker "scrape" extension
- Robust and well-tested
  - Comprehensive test suite (runs entirely offline, so it's reliable)
  - Used by popular clients: [WebTorrent](http://webtorrent.io), [peerflix](https://github.com/mafintosh/peerflix), and [playback](https://mafintosh.github.io/playback/)
- Tracker statistics available via web interface at `/stats`

Also see [bittorrent-dht](https://github.com/feross/bittorrent-dht).

## install

```
npm install bittorrent-tracker
```

## usage

### client

To connect to a tracker, just do this:

```js
var Client = require('bittorrent-tracker')

var requiredOpts = {
  infoHash: new Buffer('012345678901234567890'), // hex string or Buffer
  peerId: new Buffer('01234567890123456789'), // hex string or Buffer
  announce: [], // list of tracker server urls
  port: 6881 // torrent client port, (in browser, optional)
}

var optionalOpts = {
  // RTCPeerConnection config object (only used in browser)
  rtcConfig: {},
  // custom webrtc impl, useful in node to specify [wrtc](https://npmjs.com/package/wrtc)
  wrtc: {},
  getAnnounceOpts: function () {
    // provide a callback that will be called whenever announce() is called
    // internally (on timer), or by the user
    return {
      uploaded: 0,
      downloaded: 0,
      left: 0,
      customParam: 'blah' // custom parameters supported
    }
  }
}

var client = new Client(requiredOpts)

client.on('error', function (err) {
  // fatal client error!
  console.log(err.message)
})

client.on('warning', function (err) {
  // a tracker was unavailable or sent bad data to the client. you can probably ignore it
  console.log(err.message)
})

// start getting peers from the tracker
client.start()

client.on('update', function (data) {
  console.log('got an announce response from tracker: ' + data.announce)
  console.log('number of seeders in the swarm: ' + data.complete)
  console.log('number of leechers in the swarm: ' + data.incomplete)
})

client.once('peer', function (addr) {
  console.log('found a peer: ' + addr) // 85.10.239.191:48623
})

// announce that download has completed (and you are now a seeder)
client.complete()

// force a tracker announce. will trigger more 'update' events and maybe more 'peer' events
client.update()

// provide parameters to the tracker
client.update({
  uploaded: 0,
  downloaded: 0,
  left: 0,
  customParam: 'blah' // custom parameters supported
})

// stop getting peers from the tracker, gracefully leave the swarm
client.stop()

// ungracefully leave the swarm (without sending final 'stop' message)
client.destroy()

// scrape
client.scrape()

client.on('scrape', function (data) {
  console.log('got a scrape response from tracker: ' + data.announce)
  console.log('number of seeders in the swarm: ' + data.complete)
  console.log('number of leechers in the swarm: ' + data.incomplete)
  console.log('number of total downloads of this torrent: ' + data.downloaded)
})
```

### server

To start a BitTorrent tracker server to track swarms of peers:

```js
var Server = require('bittorrent-tracker').Server

var server = new Server({
  udp: true, // enable udp server? [default=true]
  http: true, // enable http server? [default=true]
  ws: true, // enable websocket server? [default=true]
  stats: true, // enable web-based statistics? [default=true]
  filter: function (infoHash, params, cb) {
    // Blacklist/whitelist function for allowing/disallowing torrents. If this option is
    // omitted, all torrents are allowed. It is possible to interface with a database or
    // external system before deciding to allow/deny, because this function is async.

    // It is possible to block by peer id (whitelisting torrent clients) or by secret
    // key (private trackers). Full access to the original HTTP/UDP request parameters
    // are available in `params`.

    // This example only allows one torrent.

    var allowed = (infoHash === 'aaa67059ed6bd08362da625b3ae77f6f4a075aaa')
    cb(allowed)

    // In addition to returning a boolean (`true` for allowed, `false` for disallowed),
    // you can return an `Error` object to disallow and provide a custom reason.
  }
})

// Internal http, udp, and websocket servers exposed as public properties.
server.http
server.udp
server.ws

server.on('error', function (err) {
  // fatal server error!
  console.log(err.message)
})

server.on('warning', function (err) {
  // client sent bad data. probably not a problem, just a buggy client.
  console.log(err.message)
})

server.on('listening', function () {
  // fired when all requested servers are listening
  console.log('listening on http port:' + server.http.address().port)
  console.log('listening on udp port:' + server.udp.address().port)
})

// start tracker server listening! Use 0 to listen on a random free port.
server.listen(port, hostname, onlistening)

// listen for individual tracker messages from peers:

server.on('start', function (addr) {
  console.log('got start message from ' + addr)
})

server.on('complete', function (addr) {})
server.on('update', function (addr) {})
server.on('stop', function (addr) {})

// get info hashes for all torrents in the tracker server
Object.keys(server.torrents)

// get the number of seeders for a particular torrent
server.torrents[infoHash].complete

// get the number of leechers for a particular torrent
server.torrents[infoHash].incomplete

// get the peers who are in a particular torrent swarm
server.torrents[infoHash].peers
```

The http server will handle requests for the following paths: `/announce`, `/scrape`. Requests for other paths will not be handled.

## multi scrape

Scraping multiple torrent info is possible with a static `Client.scrape` method:

```js
var Client = require('bittorrent-tracker')
Client.scrape(announceUrl, [ infoHash1, infoHash2 ], function (err, results) {
  results[infoHash1].announce
  results[infoHash1].infoHash
  results[infoHash1].complete
  results[infoHash1].incomplete
  results[infoHash1].downloaded

  // ...
})
````

## command line

Easily start a tracker server:

```sh
$ bittorrent-tracker
http server listening on 8000
udp server listening on 8000
ws server listening on 8000
```

Lots of options:

```sh
$ bittorrent-tracker --help
  bittorrent-tracker - Start a bittorrent tracker server

  Usage:
    bittorrent-tracker [OPTIONS]

  If no --http, --udp, or --ws option is supplied, all tracker types will be started.

  Options:
    -p, --port [number]  change the port [default: 8000]
        --trust-proxy    trust 'x-forwarded-for' header from reverse proxy
        --interval       client announce interval (ms) [default: 600000]
        --http           enable http server
        --udp            enable udp server
        --ws             enable websocket server
    -q, --quiet          only show error output
    -s, --silent         show no output
    -v, --version        print the current version

  Please report bugs!  https://github.com/feross/bittorrent-tracker/issues
```

## license

MIT. Copyright (c) [Feross Aboukhadijeh](http://feross.org).
