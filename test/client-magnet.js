var Client = require('../')
var common = require('./common')
var magnet = require('magnet-uri')
var test = require('tape')

var uri = 'magnet:?xt=urn:btih:d2474e86c95b19b8bcfdb92bc12c9d44667cfa36&dn=Leaves+of+Grass+by+Walt+Whitman.epub'
var parsedTorrent = magnet(uri)
var peerId = new Buffer('01234567890123456789')

function testMagnet (t, serverType) {
  t.plan(9)

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

test('http: magnet: client.start/update/stop()', function (t) {
  testMagnet(t, 'http')
})

test('udp: magnet: client.start/update/stop()', function (t) {
  testMagnet(t, 'udp')
})

test('ws: magnet: client.start/update/stop()', function (t) {
  testMagnet(t, 'ws')
})
