var Client = require('../').Client
var fs = require('fs')
var parseTorrent = require('parse-torrent')
var portfinder = require('portfinder')
var Server = require('../').Server
var test = require('tape')

// TODO: add test where tracker doesn't support compact

var torrent = fs.readFileSync(__dirname + '/torrents/bitlove-intro.torrent')
var parsedTorrent = parseTorrent(torrent)
var peerId = new Buffer('01234567890123456789')
var announceUrl = ''
var port = 6881

function createServer (cb) {
  var server = new Server({ udp: false })

  server.on('error', function (err) {
    t.fail(err.message)
  })

  server.on('warning', function (err) {
    t.fail(err.message)
  })

  portfinder.getPort(function (err, port) {
    if (err) return cb(err)

    announceUrl = 'http://127.0.0.1:' + port + '/announce'
    parsedTorrent.announce = [ announceUrl ]

    server.listen(port)
    cb(null, server)
  })
}

test('torrent: client.start()', function (t) {
  t.plan(6)

  createServer(function (err, server) {
    t.error(err)

    var client = new Client(peerId, port, parsedTorrent)

    client.on('error', function (err) {
      t.fail(err)
    })

    client.once('update', function (data) {
      t.equal(data.announce, announceUrl)
      t.equal(typeof data.complete, 'number')
      t.equal(typeof data.incomplete, 'number')
    })

    client.once('peer', function (addr) {
      t.pass('there is at least one peer')
      client.stop()

      client.once('update', function () {
        server.close(function () {
          t.pass('server close')
        })
      })
    })

    client.start()
  })
})

test('torrent: client.stop()', function (t) {
  t.plan(5)

  createServer(function (err, server) {
    t.error(err)
    var client = new Client(peerId, port, parsedTorrent)

    client.on('error', function (err) {
      t.fail(err)
    })

    client.start()

    setTimeout(function () {
      client.stop()

      client.once('update', function (data) {
        // receive one final update after calling stop
        t.equal(data.announce, announceUrl)
        t.equal(typeof data.complete, 'number')
        t.equal(typeof data.incomplete, 'number')

        server.close(function () {
          t.pass('server close')
        })
      })

    }, 1000)
  })
})

test('torrent: client.update()', function (t) {
  t.plan(5)

  createServer(function (err, server) {
    t.error(err)
    var client = new Client(peerId, port, parsedTorrent, { interval: 5000 })

    client.on('error', function (err) {
      t.fail(err)
    })

    client.start()

    client.once('update', function () {

      client.once('update', function (data) {
        // received an update!
        t.equal(data.announce, announceUrl)
        t.equal(typeof data.complete, 'number')
        t.equal(typeof data.incomplete, 'number')
        client.stop()

        client.once('update', function () {
          server.close(function () {
            t.pass('server close')
          })
        })
      })
    })
  })
})

test('torrent: client.scrape()', function (t) {
  t.plan(6)

  createServer(function (err, server) {
    t.error(err)
    var client = new Client(peerId, port, parsedTorrent)

    client.on('error', function (err) {
      t.fail(err)
    })

    client.once('scrape', function (data) {
      t.equal(data.announce, announceUrl)
      t.equal(typeof data.complete, 'number')
      t.equal(typeof data.incomplete, 'number')
      t.equal(typeof data.downloaded, 'number')

      server.close(function () {
        t.pass('server close')
      })
    })

    client.scrape()
  })
})
