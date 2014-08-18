# bittorrent-tracker [![build](https://img.shields.io/travis/feross/bittorrent-tracker.svg)](https://travis-ci.org/feross/bittorrent-tracker) [![npm](https://img.shields.io/npm/v/bittorrent-tracker.svg)](https://npmjs.org/package/bittorrent-tracker) [![npm downloads](https://img.shields.io/npm/dm/bittorrent-tracker.svg)](https://npmjs.org/package/bittorrent-tracker) [![gittip](https://img.shields.io/gittip/feross.svg)](https://www.gittip.com/feross/)

#### Simple, robust, BitTorrent tracker (client & server) implementation

![tracker](https://raw.githubusercontent.com/feross/bittorrent-tracker/master/img.png)

Node.js implementation of a [BitTorrent tracker](https://wiki.theory.org/BitTorrentSpecification#Tracker_HTTP.2FHTTPS_Protocol), client and server.

A **BitTorrent tracker** is an HTTP service which responds to GET requests from BitTorrent
clients. The requests include metrics from clients that help the tracker keep overall
statistics about the torrent. The response includes a peer list that helps the client
participate in the torrent.

Also see [bittorrent-dht](https://github.com/feross/bittorrent-dht). This module is used
by [WebTorrent](http://webtorrent.io).

## features

- Includes client & server implementations
- Supports HTTP & UDP trackers ([BEP 15](http://www.bittorrent.org/beps/bep_0015.html))
- Supports tracker scrape

## install

```
npm install bittorrent-tracker
```

## usage

### client

To connect to a tracker, just do this:

```js
var Client = require('bittorrent-tracker')
var parseTorrent = require('parse-torrent')
var fs = require('fs')

var torrent = fs.readFileSync(__dirname + '/torrents/bitlove-intro.torrent')
var parsedTorrent = parseTorrent(torrent) // { infoHash: 'xxx', length: xx, announce: ['xx', 'xx'] }

var peerId = new Buffer('01234567890123456789')
var port = 6881

var client = new Client(peerId, port, parsedTorrent)

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

// stop getting peers from the tracker, gracefully leave the swarm
client.stop()

// scrape
client.scrape()

client.on('scrape', function (data) {
  console.log('got a scrape response from tracker: ' + data.announce)
  console.log('number of seeders in the swarm: ' + data.complete)
  console.log('number of leechers in the swarm: ' + data.incomplete)
  console.log('number of total downloads of this torrent: ' + data.incomplete)
})
```

### server

To start a BitTorrent tracker server to track swarms of peers:

```js
var Server = require('bittorrent-tracker').Server

var server = new Server({
  udp: true, // enable udp server? [default=true]
  http: true // enable http server? [default=true]
})

server.on('error', function (err) {
  // fatal server error!
  console.log(err.message)
})

server.on('warning', function (err) {
  // client sent bad data. probably not a problem, just a buggy client.
  console.log(err.message)
})

server.on('listening', function (port) {
  console.log('tracker server is now listening on ' + port)
})

// start tracker server listening!
server.listen(port)

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

## license

MIT. Copyright (c) [Feross Aboukhadijeh](http://feross.org).
