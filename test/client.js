var Client = require('../')
var fs = require('fs')
var parseTorrent = require('parse-torrent')
var portfinder = require('portfinder')
var Server = require('../').Server
var test = require('tape')

var torrent = fs.readFileSync(__dirname + '/torrents/bitlove-intro.torrent')
var parsedTorrent = parseTorrent(torrent)
var peerId1 = new Buffer('01234567890123456789')
var announceUrl = ''
var port = 6881

function createServer (t, serverType, cb) {
  var opts = serverType === 'http' ? { udp: false } : { http: false }
  var server = new Server(opts)

  server.on('error', function (err) {
    t.error(err)
  })

  server.on('warning', function (err) {
    t.error(err)
  })

  portfinder.getPort(function (err, port) {
    if (err) return t.error(err)

    announceUrl = serverType + '://127.0.0.1:' + port + '/announce'
    parsedTorrent.announce = [ announceUrl ]

    server.listen(port)
    cb(server)
  })
}

function testClientStart (t, serverType) {
  t.plan(5)
  createServer(t, serverType, function (server) {
    var client = new Client(peerId1, port, parsedTorrent)

    client.on('error', function (err) {
      t.error(err)
    })

    client.on('warning', function (err) {
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

      client.once('update', function () {
        server.close(function () {
          t.pass('server close')
        })
      })
    })

    client.start()
  })
}

test('http: client.start()', function (t) {
  testClientStart(t, 'http')
})

test('udp: client.start()', function (t) {
  testClientStart(t, 'udp')
})

function testClientStop (t, serverType) {
  t.plan(4)
  createServer(t, serverType, function (server) {
    var client = new Client(peerId1, port, parsedTorrent)

    client.on('error', function (err) {
      t.error(err)
    })

    client.on('warning', function (err) {
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

        server.close(function () {
          t.pass('server close')
        })
      })

    }, 1000)
  })
}

test('http: client.stop()', function (t) {
  testClientStop(t, 'http')
})

test('udp: client.stop()', function (t) {
  testClientStop(t, 'udp')
})

function testClientUpdate (t, serverType) {
  t.plan(4)
  createServer(t, serverType, function (server) {
    var client = new Client(peerId1, port, parsedTorrent, { interval: 5000 })

    client.on('error', function (err) {
      t.error(err)
    })

    client.on('warning', function (err) {
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

        client.once('update', function () {
          server.close(function () {
            t.pass('server close')
          })
        })
      })
    })
  })
}

test('http: client.update()', function (t) {
  testClientUpdate(t, 'http')
})

test('udp: client.update()', function (t) {
  testClientUpdate(t, 'udp')
})

function testClientScrape (t, serverType) {
  t.plan(5)
  createServer(t, serverType, function (server) {
    var client = new Client(peerId1, port, parsedTorrent)

    client.on('error', function (err) {
      t.error(err)
    })

    client.on('warning', function (err) {
      t.error(err)
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
}

test('http: client.scrape()', function (t) {
  testClientScrape(t, 'http')
})

test('udp: client.scrape()', function (t) {
  testClientScrape(t, 'udp')
})

})
