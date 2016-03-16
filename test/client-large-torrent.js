var Client = require('../')
var common = require('./common')
var extend = require('xtend')
var fixtures = require('webtorrent-fixtures')
var test = require('tape')

var peerId = new Buffer('01234567890123456789')

function testLargeTorrent (t, serverType) {
  t.plan(9)

  var parsedTorrent = extend(fixtures.sintel.parsedTorrent)

  common.createServer(t, serverType, function (server, announceUrl) {
    parsedTorrent.announce = [ announceUrl ]
    var client = new Client(peerId, 6881, parsedTorrent, { wrtc: {} })

    if (serverType === 'ws') common.mockWebsocketTracker(client)
    client.on('error', function (err) { t.error(err) })
    client.on('warning', function (err) { t.error(err) })

    client.once('update', function (data) {
      t.equal(data.announce, announceUrl)
      t.equal(typeof data.complete, 'number')
      t.equal(typeof data.incomplete, 'number')

      client.update()

      client.once('update', function (data) {
        t.equal(data.announce, announceUrl)
        t.equal(typeof data.complete, 'number')
        t.equal(typeof data.incomplete, 'number')

        client.stop()

        client.once('update', function (data) {
          t.equal(data.announce, announceUrl)
          t.equal(typeof data.complete, 'number')
          t.equal(typeof data.incomplete, 'number')

          server.close()
          client.destroy()
        })
      })
    })

    client.start()
  })
}

test('http: large torrent: client.start()', function (t) {
  testLargeTorrent(t, 'http')
})

test('udp: large torrent: client.start()', function (t) {
  testLargeTorrent(t, 'udp')
})

test('ws: large torrent: client.start()', function (t) {
  testLargeTorrent(t, 'ws')
})
