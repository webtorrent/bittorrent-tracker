var Client = require('../').Client
var fs = require('fs')
var parseTorrent = require('parse-torrent')
var test = require('tape')

// TODO: add test where tracker doesn't support compact

var torrent = fs.readFileSync(__dirname + '/torrents/bitlove-intro.torrent')
var parsedTorrent = parseTorrent(torrent)
var peerId = new Buffer('01234567890123456789')
var announceUrl = 'http://t.bitlove.org/announce' // TODO: shouldn't rely on an external server!
var port = 6881

test('torrent: client.start()', function (t) {
  t.plan(4)

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
    t.pass('there is at least one peer')
    client.stop()
  })

  client.start()
})

test('torrent: client.stop()', function (t) {
  t.plan(4)

  var client = new Client(peerId, port, parsedTorrent)

  client.on('error', function (err) {
    t.error(err)
  })

  client.start()

  setTimeout(function () {
    client.stop()

    client.once('update', function (data) {
      // receive one final update after calling stop
      t.equal(data.announce, announceUrl)
      t.equal(typeof data.complete, 'number')
      t.equal(typeof data.incomplete, 'number')
    })

    client.once('peer', function () {
      t.pass('should get more peers on stop()')
    })
  }, 1000)
})

test('torrent: client.update()', function (t) {
  t.plan(3)

  var client = new Client(peerId, port, parsedTorrent, { interval: 5000 })

  client.on('error', function (err) {
    t.error(err)
  })

  client.start()

  client.once('update', function () {

    client.once('update', function (data) {
      // received an update!
      t.equal(data.announce, announceUrl)
      t.equal(typeof data.complete, 'number')
      t.equal(typeof data.incomplete, 'number')
      client.stop()
    })

  })
})

test('torrent: client.scrape()', function (t) {
  t.plan(4)

  var client = new Client(peerId, port, parsedTorrent)

  client.on('error', function (err) {
    t.error(err)
  })

  client.once('scrape', function (data) {
    t.equal(data.announce, announceUrl)
    t.equal(typeof data.complete, 'number')
    t.equal(typeof data.incomplete, 'number')
    t.equal(typeof data.downloaded, 'number')
  })

  client.scrape()
})
