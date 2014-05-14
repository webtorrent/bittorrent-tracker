var Client = require('../').Client
var fs = require('fs')
var magnet = require('magnet-uri')
var test = require('tape')

var uri = 'magnet:?xt=urn:btih:d2474e86c95b19b8bcfdb92bc12c9d44667cfa36&dn=Leaves+of+Grass+by+Walt+Whitman.epub&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A80'
var parsedTorrent = magnet(uri)
var peerId = new Buffer('01234567890123456789')
var announceUrl = 'udp://tracker.openbittorrent.com:80' // TODO: shouldn't rely on an external server!
var port = 6881

test('magnet + udp: client.start/update/stop()', function (t) {
  t.plan(10)

  var client = new Client(peerId, port, parsedTorrent)

  client.on('error', function (err) {
    t.error(err)
  })

  client.once('update', function (data) {
    t.equal(data.announce, announceUrl)
    t.equal(typeof data.complete, 'number')
    t.equal(typeof data.incomplete, 'number')
  })

  client.once('peer', function (addr) {
    t.pass('there is at least one peer') // TODO: this shouldn't rely on an external server!

    client.once('update', function (data) {
      // receive one final update after calling stop
      t.equal(data.announce, announceUrl)
      t.equal(typeof data.complete, 'number')
      t.equal(typeof data.incomplete, 'number')

      client.once('update', function (data) {
        // received an update!
        t.equal(data.announce, announceUrl)
        t.equal(typeof data.complete, 'number')
        t.equal(typeof data.incomplete, 'number')
      })

      client.stop()
    })

    client.update()
  })

  client.start()
})
