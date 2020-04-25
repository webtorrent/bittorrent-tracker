var Client = require('../')
var commonTest = require('./common')
var fixtures = require('webtorrent-fixtures')
var get = require('simple-get')
var test = require('tape')

var peerId = Buffer.from('-WW0091-4ea5886ce160')
var unknownPeerId = Buffer.from('01234567890123456789')

function parseHtml (html) {
  var extractValue = new RegExp('[^v^h](\\d+)')
  var array = html.replace('torrents', '\n').split('\n').filter(function (line) {
    return line && line.trim().length > 0
  }).map(function (line) {
    var a = extractValue.exec(line)
    if (a) {
      return parseInt(a[1])
    }
  })
  var i = 0
  return {
    torrents: array[i++],
    activeTorrents: array[i++],
    peersAll: array[i++],
    peersSeederOnly: array[i++],
    peersLeecherOnly: array[i++],
    peersSeederAndLeecher: array[i++],
    peersIPv4: array[i++],
    peersIPv6: array[i]
  }
}

test('server: get empty stats', function (t) {
  t.plan(11)

  commonTest.createServer(t, 'http', function (server, announceUrl) {
    var url = announceUrl.replace('/announce', '/stats')

    get.concat(url, function (err, res, data) {
      t.error(err)

      var stats = parseHtml(data.toString())
      t.equal(res.statusCode, 200)
      t.equal(stats.torrents, 0)
      t.equal(stats.activeTorrents, 0)
      t.equal(stats.peersAll, 0)
      t.equal(stats.peersSeederOnly, 0)
      t.equal(stats.peersLeecherOnly, 0)
      t.equal(stats.peersSeederAndLeecher, 0)
      t.equal(stats.peersIPv4, 0)
      t.equal(stats.peersIPv6, 0)

      server.close(function () { t.pass('server closed') })
    })
  })
})

test('server: get empty stats with json header', function (t) {
  t.plan(11)

  commonTest.createServer(t, 'http', function (server, announceUrl) {
    var opts = {
      url: announceUrl.replace('/announce', '/stats'),
      headers: {
        accept: 'application/json'
      },
      json: true
    }

    get.concat(opts, function (err, res, stats) {
      t.error(err)

      t.equal(res.statusCode, 200)
      t.equal(stats.torrents, 0)
      t.equal(stats.activeTorrents, 0)
      t.equal(stats.peersAll, 0)
      t.equal(stats.peersSeederOnly, 0)
      t.equal(stats.peersLeecherOnly, 0)
      t.equal(stats.peersSeederAndLeecher, 0)
      t.equal(stats.peersIPv4, 0)
      t.equal(stats.peersIPv6, 0)

      server.close(function () { t.pass('server closed') })
    })
  })
})

test('server: get empty stats on stats.json', function (t) {
  t.plan(11)

  commonTest.createServer(t, 'http', function (server, announceUrl) {
    var opts = {
      url: announceUrl.replace('/announce', '/stats.json'),
      json: true
    }

    get.concat(opts, function (err, res, stats) {
      t.error(err)

      t.equal(res.statusCode, 200)
      t.equal(stats.torrents, 0)
      t.equal(stats.activeTorrents, 0)
      t.equal(stats.peersAll, 0)
      t.equal(stats.peersSeederOnly, 0)
      t.equal(stats.peersLeecherOnly, 0)
      t.equal(stats.peersSeederAndLeecher, 0)
      t.equal(stats.peersIPv4, 0)
      t.equal(stats.peersIPv6, 0)

      server.close(function () { t.pass('server closed') })
    })
  })
})

test('server: get leecher stats.json', function (t) {
  t.plan(11)

  commonTest.createServer(t, 'http', function (server, announceUrl) {
    // announce a torrent to the tracker
    var client = new Client({
      infoHash: fixtures.leaves.parsedTorrent.infoHash,
      announce: announceUrl,
      peerId,
      port: 6881
    })
    client.on('error', function (err) { t.error(err) })
    client.on('warning', function (err) { t.error(err) })

    client.start()

    server.once('start', function () {
      var opts = {
        url: announceUrl.replace('/announce', '/stats.json'),
        json: true
      }

      get.concat(opts, function (err, res, stats) {
        t.error(err)

        t.equal(res.statusCode, 200)
        t.equal(stats.torrents, 1)
        t.equal(stats.activeTorrents, 1)
        t.equal(stats.peersAll, 1)
        t.equal(stats.peersSeederOnly, 0)
        t.equal(stats.peersLeecherOnly, 1)
        t.equal(stats.peersSeederAndLeecher, 0)
        t.equal(stats.clients.WebTorrent['0.91'], 1)

        client.destroy(function () { t.pass('client destroyed') })
        server.close(function () { t.pass('server closed') })
      })
    })
  })
})

test('server: get leecher stats.json (unknown peerId)', function (t) {
  t.plan(11)

  commonTest.createServer(t, 'http', function (server, announceUrl) {
    // announce a torrent to the tracker
    var client = new Client({
      infoHash: fixtures.leaves.parsedTorrent.infoHash,
      announce: announceUrl,
      peerId: unknownPeerId,
      port: 6881
    })
    client.on('error', function (err) { t.error(err) })
    client.on('warning', function (err) { t.error(err) })

    client.start()

    server.once('start', function () {
      var opts = {
        url: announceUrl.replace('/announce', '/stats.json'),
        json: true
      }

      get.concat(opts, function (err, res, stats) {
        t.error(err)

        t.equal(res.statusCode, 200)
        t.equal(stats.torrents, 1)
        t.equal(stats.activeTorrents, 1)
        t.equal(stats.peersAll, 1)
        t.equal(stats.peersSeederOnly, 0)
        t.equal(stats.peersLeecherOnly, 1)
        t.equal(stats.peersSeederAndLeecher, 0)
        t.equal(stats.clients.unknown['01234567'], 1)

        client.destroy(function () { t.pass('client destroyed') })
        server.close(function () { t.pass('server closed') })
      })
    })
  })
})
