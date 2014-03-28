var Client = require('../').Client
var fs = require('fs')
var parseTorrent = require('parse-torrent')
var test = require('tape')

var torrent = fs.readFileSync(__dirname + '/torrents/leaves.torrent')
var parsedTorrent = parseTorrent(torrent)

// remove all tracker servers except a single UDP one, for now
parsedTorrent.announce = [ 'udp://tracker.openbittorrent.com:80' ]

var peerId = new Buffer('01234567890123456789')
var port = 6881

test('udp: client.start()', function (t) {
  t.plan(4)

  var client = new Client(peerId, port, parsedTorrent)

  client.on('error', function (err) {
    t.fail(err.message)
  })

  client.once('update', function (data) {
    t.equal(data.announce, 'udp://tracker.openbittorrent.com:80')
    t.equal(typeof data.complete, 'number')
    t.equal(typeof data.incomplete, 'number')
  })

  client.once('peer', function (addr) {
    t.pass('there is at least one peer') // TODO: this shouldn't rely on an external server!
    client.stop()
  })

  client.start()
})

test('udp: client.stop()', function (t) {
  t.plan(3)

  var client = new Client(peerId, port, parsedTorrent)

  client.on('error', function (err) {
    t.fail(err.message)
  })

  client.start()

  setTimeout(function () {
    client.stop()

    client.once('update', function (data) {
      // receive one final update after calling stop
      t.equal(data.announce, 'udp://tracker.openbittorrent.com:80')
      t.equal(typeof data.complete, 'number')
      t.equal(typeof data.incomplete, 'number')
    })

  }, 1000)
})

test('udp: client.update()', function (t) {
  t.plan(3)

  var client = new Client(peerId, port, parsedTorrent, { interval: 5000 })

  client.on('error', function (err) {
    t.fail(err.message)
  })

  client.start()

  client.once('update', function () {

    client.once('update', function (data) {
      // received an update!
      t.equal(data.announce, 'udp://tracker.openbittorrent.com:80')
      t.equal(typeof data.complete, 'number')
      t.equal(typeof data.incomplete, 'number')
      client.stop()
    })

  })
})
