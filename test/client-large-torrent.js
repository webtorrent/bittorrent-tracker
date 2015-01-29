var Client = require('../')
var fs = require('fs')
var parseTorrent = require('parse-torrent')
var Server = require('../').Server
var test = require('tape')

var torrent = fs.readFileSync(__dirname + '/torrents/sintel-5gb.torrent')
var parsedTorrent = parseTorrent(torrent)
var peerId = new Buffer('01234567890123456789')

test('large torrent: client.start()', function (t) {
  t.plan(5)

  var server = new Server({ http: false })

  server.on('error', function (err) {
    t.fail(err.message)
  })

  server.on('warning', function (err) {
    t.fail(err.message)
  })

  server.listen(0, function () {
    var port = server.udp.address().port

    // remove all tracker servers except a single UDP one, for now
    parsedTorrent.announce = [ 'udp://127.0.0.1:' + port ]

    var client = new Client(peerId, 6881, parsedTorrent)

    client.on('error', function (err) {
      t.error(err)
    })

    client.once('update', function (data) {
      t.equal(data.announce, 'udp://127.0.0.1:' + port)
      t.equal(typeof data.complete, 'number')
      t.equal(typeof data.incomplete, 'number')
    })

    client.start()

    client.once('peer', function () {
      t.pass('there is at least one peer')

      client.stop()

      client.once('update', function () {
        server.close(function () {
          t.pass('server close')
        })
      })
    })
  })
})
