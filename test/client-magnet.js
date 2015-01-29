var Client = require('../')
var magnet = require('magnet-uri')
var Server = require('../').Server
var test = require('tape')

var uri = 'magnet:?xt=urn:btih:d2474e86c95b19b8bcfdb92bc12c9d44667cfa36&dn=Leaves+of+Grass+by+Walt+Whitman.epub&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A80'
var parsedTorrent = magnet(uri)
var peerId = new Buffer('01234567890123456789')

test('magnet + udp: client.start/update/stop()', function (t) {
  t.plan(11)

  var server = new Server({ http: false })

  server.on('error', function (err) {
    t.fail(err.message)
  })

  server.on('warning', function (err) {
    t.fail(err.message)
  })

  server.listen(0, function () {
    var port = server.udp.address().port
    var announceUrl = 'udp://127.0.0.1:' + port

    // remove all tracker servers except a single UDP one, for now
    parsedTorrent.announce = [ announceUrl ]

    var client = new Client(peerId, 6881, parsedTorrent)

    client.on('error', function (err) {
      t.error(err)
    })

    client.once('update', function (data) {
      t.equal(data.announce, announceUrl)
      t.equal(typeof data.complete, 'number')
      t.equal(typeof data.incomplete, 'number')
    })

    client.start()

    client.once('peer', function () {
      t.pass('there is at least one peer')

      client.update()

      client.once('update', function (data) {
        // receive one final update after calling stop
        t.equal(data.announce, announceUrl)
        t.equal(typeof data.complete, 'number')
        t.equal(typeof data.incomplete, 'number')

        client.stop()

        client.once('update', function (data) {
          // received an update!
          t.equal(data.announce, announceUrl)
          t.equal(typeof data.complete, 'number')
          t.equal(typeof data.incomplete, 'number')

          server.close(function () {
            t.pass('server closed')
          })
        })
      })
    })
  })
})
