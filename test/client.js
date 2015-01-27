var Client = require('../')
var common = require('./common')
var fs = require('fs')
var parseTorrent = require('parse-torrent')
var test = require('tape')

var torrent = fs.readFileSync(__dirname + '/torrents/bitlove-intro.torrent')
var parsedTorrent = parseTorrent(torrent)
var peerId1 = new Buffer('01234567890123456789')
var peerId2 = new Buffer('12345678901234567890')
var peerId3 = new Buffer('23456789012345678901')
var port = 6881

function testClientStart (t, serverType) {
  t.plan(5)
  common.createServer(t, serverType, function (server, announceUrl) {
    parsedTorrent.announce = [ announceUrl ]
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

    client.once('peer', function () {
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
  common.createServer(t, serverType, function (server, announceUrl) {
    parsedTorrent.announce = [ announceUrl ]
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
  common.createServer(t, serverType, function (server, announceUrl) {
    parsedTorrent.announce = [ announceUrl ]
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
  common.createServer(t, serverType, function (server, announceUrl) {
    parsedTorrent.announce = [ announceUrl ]
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

function testClientAnnounceWithNumWant (t, serverType) {
  t.plan(1)
  common.createServer(t, serverType, function (server, announceUrl) {
    parsedTorrent.announce = [ announceUrl ]
    var client1 = new Client(peerId1, port, parsedTorrent)
    client1.on('error', function (err) {
      t.error(err)
    })

    client1.start()
    client1.once('update', function () {
      var client2 = new Client(peerId2, port + 1, parsedTorrent)
      client2.on('error', function (err) {
        t.error(err)
      })
      client2.start()
      client2.once('update', function () {
        var client3 = new Client(peerId3, port + 2, parsedTorrent, { numWant: 1 })
        client3.on('error', function (err) {
          t.error(err)
        })
        client3.start()
        client3.on('peer', function () {
          t.pass('got one peer (this should only fire once)')

          client1.stop()
          client2.stop()
          client3.stop()
          server.close()
        })
      })
    })
  })
}

test('http: client announce with numWant', function (t) {
  testClientAnnounceWithNumWant(t, 'http')
})

test('udp: client announce with numWant', function (t) {
  testClientAnnounceWithNumWant(t, 'udp')
})
