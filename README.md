# uwt [![travis][travis-image]][travis-url] [![npm][npm-image]][npm-url] [![downloads][downloads-image]][downloads-url]

[travis-image]: https://img.shields.io/travis/DiegoRBaquero/uwt/master.svg
[travis-url]: https://travis-ci.org/DiegoRBaquero/uwt
[npm-image]: https://img.shields.io/npm/v/uwt.svg
[npm-url]: https://npmjs.org/package/uwt
[downloads-image]: https://img.shields.io/npm/dm/uwt.svg
[downloads-url]: https://npmjs.org/package/uwt

#### µWT is a simple, robust and lightweight WebTorrent tracker server implementation

![tracker](https://raw.githubusercontent.com/DiegoRBaquero/uwt/master/img.png)

Node.js implementation of a [BitTorrent tracker](https://wiki.theory.org/BitTorrentSpecification#Tracker_HTTP.2FHTTPS_Protocol) for WebTorrent clients.

A **BitTorrent tracker** is a web service which responds to requests from BitTorrent
clients. The requests include metrics from clients that help the tracker keep overall
statistics about the torrent. The response includes a peer list that helps the client
participate in the torrent swarm.

This module is used by [βTorrent Tracker](https://tracker.btorrent.xyz), the first community operated [WebTorrent](http://webtorrent.io) tracker.

## features

- Fast & lightweight server implementation
- Supports ipv4 & ipv6
- Supports tracker "scrape" extension
- Robust and well-tested
  - Comprehensive test suite (runs entirely offline, so it's reliable)
- Tracker statistics available via web interface at `/stats` or JSON data at `/stats.json`

## install

```
npm install uwt
```

## usage

### server

To start a WebTorrent tracker server to track swarms of peers:

```js
var Server = require('uwt')

var server = new Server({
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

// Internal websocket and http servers exposed as public properties.
server.ws
server.http

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

## command line

Easily start a tracker server:

```sh
$ webtorrent-tracker
server listening on 8000
```

Lots of options:

```sh
$ webtorrent-tracker --help
  webtorrent-tracker - Start a webtorrent tracker server

  Usage:
    webtorrent-tracker [OPTIONS]

  Options:
    -p, --port [number]  change the port [default: 8000]
        --trust-proxy    trust 'x-forwarded-for' header from reverse proxy
        --interval       client announce interval (ms) [default: 600000]
        --ws             enable websocket server
    -q, --quiet          only show error output
    -s, --silent         show no output
    -v, --version        print the current version

  Please report bugs!  https://github.com/feross/bittorrent-tracker/issues
```

## License

MIT. Copyright (c) [Feross Aboukhadijeh](http://feross.org).
