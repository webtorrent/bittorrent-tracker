# bittorrent-tracker [![build](http://img.shields.io/travis/feross/bittorrent-tracker.svg)](https://travis-ci.org/feross/bittorrent-tracker) [![npm](http://img.shields.io/npm/v/bittorrent-tracker.svg)](https://npmjs.org/package/bittorrent-tracker) [![gittip](http://img.shields.io/gittip/feross.svg)](https://www.gittip.com/feross/)

### Simple, robust, BitTorrent tracker (client & server) implementation

Node.js implementation of a [BitTorrent tracker](https://wiki.theory.org/BitTorrentSpecification#Tracker_HTTP.2FHTTPS_Protocol), client and server.

A **BitTorrent tracker** is an HTTP service which responds to GET requests from BitTorrent
clients. The requests include metrics from clients that help the tracker keep overall
statistics about the torrent. The response includes a peer list that helps the client
participate in the torrent.

Also see [bittorrent-dht](https://github.com/feross/bittorrent-dht). This module is used
by [WebTorrent](http://webtorrent.io).

## install

```
npm install bittorrent-tracker
```

## usage

To connect to a tracker, just do this:

```js
var Client = require('bittorrent-tracker').Client
var parseTorrent = require('parse-torrent')

var torrent = fs.readFileSync(__dirname + '/torrents/bitlove-intro.torrent')
var parsedTorrent = parseTorrent(torrent) // { infoHash: 'xxx', length: xx, announce: ['xx', 'xx'] }

var peerId = new Buffer('01234567890123456789')
var port = 6881

var client = new Client(peerId, port, parsedTorrent)

// you must add an 'error' event handler!
client.on('error', function (err) {
  console.log(err.message)
  // a tracker was unavailable or sent bad data to the client. you can probably ignore it
})

// start getting peers from the tracker
client.start()

client.on('update', function (data) {
  console.log('got a response from tracker: ' + data.announce)
  console.log('number of seeders on this tracker: ' + data.complete)
  console.log('number of leechers on this tracker: ' + data.incomplete)
})

client.once('peer', function (addr) {
  console.log('found a peer: ' + addr) // 85.10.239.191:48623
})

// announce that download has completed (and you are now a seeder)
client.complete()

// force a tracker announce. will trigger more 'update' events and maybe more 'peer' events
client.update()

// stop getting peers from the tracker, gracefully leave the swarm
client.stop()
```

**TODO: Add a BitTorrent tracker server implementation to this package.**

```js
var Server = require('bittorrent-tracker').Server

// TODO
```

## license

MIT. Copyright (c) [Feross Aboukhadijeh](http://feross.org).
