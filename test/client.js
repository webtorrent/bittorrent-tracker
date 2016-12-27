var Buffer = require('safe-buffer').Buffer
var Client = require('bittorrent-tracker')
var common = require('./common')
var fixtures = require('webtorrent-fixtures')
var test = require('tape')

var peerId1 = Buffer.from('01234567890123456789')
var port = 6881

function onUpdate (t, client, server, announceUrl) {
  return function (data) {
    t.equal(data.announce, announceUrl)
    t.equal(typeof data.complete, 'number')
    t.equal(typeof data.incomplete, 'number')

    client.stop()

    client.once('update', function () {
      t.pass('got response to stop')
      server.close()
      client.destroy()
    })
  }
}

test('client.start()', function (t) {
  t.plan(4)

  common.createServer(t, {}, function (server, announceUrl) {
    var client = new Client({
      infoHash: fixtures.leaves.parsedTorrent.infoHash,
      announce: announceUrl,
      peerId: peerId1,
      port: port,
      wrtc: {}
    })

    common.mockWebsocketTracker(client)
    client.on('error', function (err) { t.error(err) })
    client.on('warning', function (err) { t.error(err) })

    client.once('update', onUpdate(t, client, server, announceUrl))

    client.start()
  })
})

test('client.stop()', function (t) {
  t.plan(3)

  common.createServer(t, {}, function (server, announceUrl) {
    var client = new Client({
      infoHash: fixtures.leaves.parsedTorrent.infoHash,
      announce: announceUrl,
      peerId: peerId1,
      port: port,
      wrtc: {}
    })

    common.mockWebsocketTracker(client)
    client.on('error', function (err) { t.error(err) })
    client.on('warning', function (err) { t.error(err) })

    client.start()

    setTimeout(function () {
      client.stop()

      client.once('update', function (data) {
        // receive one final update after calling stop
        t.equal(data.announce, announceUrl)
        t.equal(typeof data.complete, 'number')
        t.equal(typeof data.incomplete, 'number')

        server.close()
        client.destroy()
      })
    }, 1000)
  })
})

test('client.update()', function (t) {
  t.plan(4)

  common.createServer(t, {}, function (server, announceUrl) {
    var client = new Client({
      infoHash: fixtures.leaves.parsedTorrent.infoHash,
      announce: announceUrl,
      peerId: peerId1,
      port: port,
      wrtc: {}
    })

    common.mockWebsocketTracker(client)
    client.on('error', function (err) { t.error(err) })
    client.on('warning', function (err) { t.error(err) })

    client.setInterval(2000)

    client.start()

    client.once('update', function () {
      client.setInterval(2000)

      // after interval (2s), we should get another update
      client.once('update', onUpdate(t, client, server, announceUrl))
    })
  })
})

test('client.scrape()', function (t) {
  t.plan(4)

  common.createServer(t, {}, function (server, announceUrl) {
    var client = new Client({
      infoHash: fixtures.leaves.parsedTorrent.infoHash,
      announce: announceUrl,
      peerId: peerId1,
      port: port,
      wrtc: {}
    })

    common.mockWebsocketTracker(client)
    client.on('error', function (err) { t.error(err) })
    client.on('warning', function (err) { t.error(err) })

    client.once('scrape', function (data) {
      t.equal(data.announce, announceUrl)
      t.equal(typeof data.complete, 'number')
      t.equal(typeof data.incomplete, 'number')
      t.equal(typeof data.downloaded, 'number')

      server.close()
      client.destroy()
    })

    client.scrape()
  })
})

test('client.announce() with params', function (t) {
  t.plan(5)

  common.createServer(t, {}, function (server, announceUrl) {
    var client = new Client({
      infoHash: fixtures.leaves.parsedTorrent.infoHash,
      announce: announceUrl,
      peerId: peerId1,
      port: port,
      wrtc: {}
    })

    server.on('start', function (peer, params) {
      t.equal(params.testParam, 'this is a test')
    })

    common.mockWebsocketTracker(client)
    client.on('error', function (err) { t.error(err) })
    client.on('warning', function (err) { t.error(err) })

    client.once('update', onUpdate(t, client, server, announceUrl))

    client.start({
      testParam: 'this is a test'
    })
  })
})

test('client `opts.getAnnounceOpts`', function (t) {
  t.plan(5)

  common.createServer(t, {}, function (server, announceUrl) {
    var client = new Client({
      infoHash: fixtures.leaves.parsedTorrent.infoHash,
      announce: announceUrl,
      peerId: peerId1,
      port: port,
      getAnnounceOpts: function () {
        return {
          testParam: 'this is a test'
        }
      },
      wrtc: {}
    })

    server.on('start', function (peer, params) {
      t.equal(params.testParam, 'this is a test')
    })

    common.mockWebsocketTracker(client)
    client.on('error', function (err) { t.error(err) })
    client.on('warning', function (err) { t.error(err) })

    client.once('update', onUpdate(t, client, server, announceUrl))

    client.start()
  })
})
