var Client = require('../')
var common = require('./common')
var extend = require('xtend')
var fixtures = require('webtorrent-fixtures')
var test = require('tape')

var peerId = new Buffer('01234567890123456789')

function testFilterOption (t, serverType) {
  t.plan(8)

  var parsedAlice = extend(fixtures.alice.parsedTorrent)
  var parsedLeaves = extend(fixtures.leaves.parsedTorrent)

  var opts = { serverType: serverType } // this is test-suite-only option
  opts.filter = function (infoHash, params, cb) {
    process.nextTick(function () {
      cb(infoHash !== parsedAlice.infoHash)
    })
  }

  common.createServer(t, opts, function (server, announceUrl) {
    parsedAlice.announce = [ announceUrl ]
    parsedLeaves.announce = [ announceUrl ]

    var client = new Client(peerId, 6881, parsedAlice, { wrtc: {} })

    client.on('error', function (err) { t.error(err) })
    if (serverType === 'ws') common.mockWebsocketTracker(client)

    client.once('warning', function (err) {
      t.ok(/disallowed info_hash/.test(err.message), 'got client warning')

      client.destroy(function () {
        t.pass('client destroyed')
        client = new Client(peerId, 6881, parsedLeaves, { wrtc: {} })
        if (serverType === 'ws') common.mockWebsocketTracker(client)

        client.on('error', function (err) { t.error(err) })
        client.on('warning', function (err) { t.error(err) })

        client.on('update', function () {
          t.pass('got announce')
          client.destroy(function () { t.pass('client destroyed') })
          server.close(function () { t.pass('server closed') })
        })

        server.on('start', function () {
          t.equal(Object.keys(server.torrents).length, 1)
        })

        client.start()
      })
    })

    server.removeAllListeners('warning')
    server.once('warning', function (err) {
      t.ok(/disallowed info_hash/.test(err.message), 'got server warning')
      t.equal(Object.keys(server.torrents).length, 0)
    })

    client.start()
  })
}

test('http: filter option blocks tracker from tracking torrent', function (t) {
  testFilterOption(t, 'http')
})

test('udp: filter option blocks tracker from tracking torrent', function (t) {
  testFilterOption(t, 'udp')
})

test('ws: filter option blocks tracker from tracking torrent', function (t) {
  testFilterOption(t, 'ws')
})

function testFilterCustomError (t, serverType) {
  t.plan(8)

  var parsedLeaves = extend(fixtures.leaves.parsedTorrent)
  var parsedAlice = extend(fixtures.alice.parsedTorrent)

  var opts = { serverType: serverType } // this is test-suite-only option
  opts.filter = function (infoHash, params, cb) {
    process.nextTick(function () {
      if (infoHash === parsedAlice.infoHash) cb(new Error('alice blocked'))
      else cb(true)
    })
  }

  common.createServer(t, opts, function (server, announceUrl) {
    parsedAlice.announce = [ announceUrl ]
    parsedLeaves.announce = [ announceUrl ]

    var client = new Client(peerId, 6881, parsedAlice, { wrtc: {} })

    client.on('error', function (err) { t.error(err) })
    if (serverType === 'ws') common.mockWebsocketTracker(client)

    client.once('warning', function (err) {
      t.ok(/alice blocked/.test(err.message), 'got client warning')

      client.destroy(function () {
        t.pass('client destroyed')
        client = new Client(peerId, 6881, parsedLeaves, { wrtc: {} })
        if (serverType === 'ws') common.mockWebsocketTracker(client)

        client.on('error', function (err) { t.error(err) })
        client.on('warning', function (err) { t.error(err) })

        client.on('update', function () {
          t.pass('got announce')
          client.destroy(function () { t.pass('client destroyed') })
          server.close(function () { t.pass('server closed') })
        })

        server.on('start', function () {
          t.equal(Object.keys(server.torrents).length, 1)
        })

        client.start()
      })
    })

    server.removeAllListeners('warning')
    server.once('warning', function (err) {
      t.ok(/alice blocked/.test(err.message), 'got server warning')
      t.equal(Object.keys(server.torrents).length, 0)
    })

    client.start()
  })
}

test('http: filter option with custom error', function (t) {
  testFilterCustomError(t, 'http')
})

test('udp: filter option filter option with custom error', function (t) {
  testFilterCustomError(t, 'udp')
})

test('ws: filter option filter option with custom error', function (t) {
  testFilterCustomError(t, 'ws')
})
