var Buffer = require('safe-buffer').Buffer
var Client = require('../')
var common = require('./common')
var fixtures = require('webtorrent-fixtures')
var magnet = require('magnet-uri')
var test = require('tape')

var peerId = Buffer.from('01234567890123456789')

function testMagnet (t, serverType) {
  t.plan(9)

  var parsedTorrent = magnet(fixtures.leaves.magnetURI)

  common.createServer(t, serverType, function (server, announceUrl) {
    var client = new Client({
      infoHash: parsedTorrent.infoHash,
      announce: announceUrl,
      peerId: peerId,
      port: 6881,
      wrtc: {}
    })

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

test('http: magnet: client.start/update/stop()', function (t) {
  testMagnet(t, 'http')
})

test('udp: magnet: client.start/update/stop()', function (t) {
  testMagnet(t, 'udp')
})

test('ws: magnet: client.start/update/stop()', function (t) {
  testMagnet(t, 'ws')
})
