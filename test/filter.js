var Client = require('../')
var common = require('./common')
var fixtures = require('webtorrent-fixtures')
var test = require('tape')

var peerId = Buffer.from('01234567890123456789')

function testFilterOption (t, serverType) {
  t.plan(8)

  var opts = { serverType: serverType } // this is test-suite-only option
  opts.filter = function (infoHash, params, cb) {
    process.nextTick(function () {
      if (infoHash === fixtures.alice.parsedTorrent.infoHash) {
        cb(new Error('disallowed info_hash (Alice)'))
      } else {
        cb(null)
      }
    })
  }

  common.createServer(t, opts, function (server, announceUrl) {
    var client1 = new Client({
      infoHash: fixtures.alice.parsedTorrent.infoHash,
      announce: announceUrl,
      peerId: peerId,
      port: 6881,
      wrtc: {}
    })

    client1.on('error', function (err) { t.error(err) })
    if (serverType === 'ws') common.mockWebsocketTracker(client1)

    client1.once('warning', function (err) {
      t.ok(err.message.includes('disallowed info_hash (Alice)'), 'got client warning')

      client1.destroy(function () {
        t.pass('client1 destroyed')

        var client2 = new Client({
          infoHash: fixtures.leaves.parsedTorrent.infoHash,
          announce: announceUrl,
          peerId: peerId,
          port: 6881,
          wrtc: {}
        })
        if (serverType === 'ws') common.mockWebsocketTracker(client2)

        client2.on('error', function (err) { t.error(err) })
        client2.on('warning', function (err) { t.error(err) })

        client2.on('update', function () {
          t.pass('got announce')
          client2.destroy(function () { t.pass('client2 destroyed') })
          server.close(function () { t.pass('server closed') })
        })

        server.on('start', function () {
          t.equal(Object.keys(server.torrents).length, 1)
        })

        client2.start()
      })
    })

    server.removeAllListeners('warning')
    server.once('warning', function (err) {
      t.ok(err.message.includes('disallowed info_hash (Alice)'), 'got server warning')
      t.equal(Object.keys(server.torrents).length, 0)
    })

    client1.start()
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

  var opts = { serverType: serverType } // this is test-suite-only option
  opts.filter = function (infoHash, params, cb) {
    process.nextTick(function () {
      if (infoHash === fixtures.alice.parsedTorrent.infoHash) {
        cb(new Error('alice blocked'))
      } else {
        cb(null)
      }
    })
  }

  common.createServer(t, opts, function (server, announceUrl) {
    var client1 = new Client({
      infoHash: fixtures.alice.parsedTorrent.infoHash,
      announce: announceUrl,
      peerId: peerId,
      port: 6881,
      wrtc: {}
    })

    client1.on('error', function (err) { t.error(err) })
    if (serverType === 'ws') common.mockWebsocketTracker(client1)

    client1.once('warning', function (err) {
      t.ok(/alice blocked/.test(err.message), 'got client warning')

      client1.destroy(function () {
        t.pass('client1 destroyed')
        var client2 = new Client({
          infoHash: fixtures.leaves.parsedTorrent.infoHash,
          announce: announceUrl,
          peerId: peerId,
          port: 6881,
          wrtc: {}
        })
        if (serverType === 'ws') common.mockWebsocketTracker(client2)

        client2.on('error', function (err) { t.error(err) })
        client2.on('warning', function (err) { t.error(err) })

        client2.on('update', function () {
          t.pass('got announce')
          client2.destroy(function () { t.pass('client2 destroyed') })
          server.close(function () { t.pass('server closed') })
        })

        server.on('start', function () {
          t.equal(Object.keys(server.torrents).length, 1)
        })

        client2.start()
      })
    })

    server.removeAllListeners('warning')
    server.once('warning', function (err) {
      t.ok(/alice blocked/.test(err.message), 'got server warning')
      t.equal(Object.keys(server.torrents).length, 0)
    })

    client1.start()
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
