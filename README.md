# bittorrent-tracker [![travis][travis-image]][travis-url] [![npm][npm-image]][npm-url] [![downloads][downloads-image]][downloads-url]

[travis-image]: https://img.shields.io/travis/feross/bittorrent-tracker.svg?style=flat
[travis-url]: https://travis-ci.org/feross/bittorrent-tracker
[npm-image]: https://img.shields.io/npm/v/bittorrent-tracker.svg?style=flat
[npm-url]: https://npmjs.org/package/bittorrent-tracker
[downloads-image]: https://img.shields.io/npm/dm/bittorrent-tracker.svg?style=flat
[downloads-url]: https://npmjs.org/package/bittorrent-tracker

#### Simple, robust, BitTorrent tracker (client & server) implementation

![tracker](https://raw.githubusercontent.com/feross/bittorrent-tracker/master/img.png)

Node.js implementation of a [BitTorrent tracker](https://wiki.theory.org/BitTorrentSpecification#Tracker_HTTP.2FHTTPS_Protocol), client and server.

A **BitTorrent tracker** is an HTTP service which responds to GET requests from BitTorrent
clients. The requests include metrics from clients that help the tracker keep overall
statistics about the torrent. The response includes a peer list that helps the client
participate in the torrent.

This module is used by [WebTorrent](http://webtorrent.io).

## features

- includes client & server implementations
- supports HTTP & UDP trackers ([BEP 15](http://www.bittorrent.org/beps/bep_0015.html))
- supports tracker "scrape" extension
- robust and well-tested (comprehensive test suite, and used by [WebTorrent](http://webtorrent.io) and [peerflix](https://github.com/mafintosh/peerflix))
- supports ipv4 & ipv6

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

// ungracefully leave the swarm (without sending final 'stop' message)
client.destroy()

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
  http: true, // enable http server? [default=true]
  filter: function (infoHash, params) {
    // black/whitelist for disallowing/allowing torrents [default=allow all]
    // this example only allows this one torrent
    return infoHash === 'aaa67059ed6bd08362da625b3ae77f6f4a075aaa'

    // you can also block by peer id (whitelisting torrent clients) or by
    // secret key, as you get full access to the original http GET
    // request parameters in `params`
  })
})

// Internal http and udp servers exposed as public properties.
server.http
server.udp

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
