var bencode = require('bencode')
var Client = require('../')
var commonLib = require('../lib/common')
var commonTest = require('./common')
var fs = require('fs')
var get = require('simple-get')
var parseTorrent = require('parse-torrent')
var path = require('path')
var test = require('tape')

var infoHash1 = 'aaa67059ed6bd08362da625b3ae77f6f4a075aaa'
var binaryInfoHash1 = commonLib.hexToBinary(infoHash1)
var infoHash2 = 'bbb67059ed6bd08362da625b3ae77f6f4a075bbb'
var binaryInfoHash2 = commonLib.hexToBinary(infoHash2)

var bitlove = fs.readFileSync(path.join(__dirname, 'torrents/bitlove-intro.torrent'))
var parsedBitlove = parseTorrent(bitlove)
var binaryBitlove = commonLib.hexToBinary(parsedBitlove.infoHash)

var peerId = new Buffer('01234567890123456789')

function testSingle (t, serverType) {
  commonTest.createServer(t, serverType, function (server, announceUrl) {
    parsedBitlove.announce = [ announceUrl ]
    var client = new Client(peerId, 6881, parsedBitlove)

    client.on('error', function (err) {
      t.error(err)
    })

    client.on('warning', function (err) {
      t.error(err)
    })

    client.scrape()

    client.on('scrape', function (data) {
      t.equal(data.announce, announceUrl)
      t.equal(data.infoHash, parsedBitlove.infoHash)
      t.equal(typeof data.complete, 'number')
      t.equal(typeof data.incomplete, 'number')
      t.equal(typeof data.downloaded, 'number')
      client.destroy()
      server.close(function () {
        t.end()
      })
    })
  })
}

test('http: single info_hash scrape', function (t) {
  testSingle(t, 'http')
})

test('udp: single info_hash scrape', function (t) {
  testSingle(t, 'udp')
})

function clientScrapeStatic (t, serverType) {
  commonTest.createServer(t, serverType, function (server, announceUrl) {
    Client.scrape(announceUrl, infoHash1, function (err, data) {
      t.error(err)
      t.equal(data.announce, announceUrl)
      t.equal(data.infoHash, infoHash1)
      t.equal(typeof data.complete, 'number')
      t.equal(typeof data.incomplete, 'number')
      t.equal(typeof data.downloaded, 'number')
      server.close(function () {
        t.end()
      })
    })
  })
}

test('http: scrape using Client.scrape static method', function (t) {
  clientScrapeStatic(t, 'http')
})

test('udp: scrape using Client.scrape static method', function (t) {
  clientScrapeStatic(t, 'udp')
})

function clientScrapeMulti (t, serverType) {
  commonTest.createServer(t, serverType, function (server, announceUrl) {
    Client.scrape(announceUrl, [ infoHash1, infoHash2 ], function (err, results) {
      t.error(err)

      t.equal(results[infoHash1].announce, announceUrl)
      t.equal(results[infoHash1].infoHash, infoHash1)
      t.equal(typeof results[infoHash1].complete, 'number')
      t.equal(typeof results[infoHash1].incomplete, 'number')
      t.equal(typeof results[infoHash1].downloaded, 'number')

      t.equal(results[infoHash2].announce, announceUrl)
      t.equal(results[infoHash2].infoHash, infoHash2)
      t.equal(typeof results[infoHash2].complete, 'number')
      t.equal(typeof results[infoHash2].incomplete, 'number')
      t.equal(typeof results[infoHash2].downloaded, 'number')

      server.close(function () {
        t.end()
      })
    })
  })
}

test('http: MULTI scrape using Client.scrape static method', function (t) {
  clientScrapeMulti(t, 'http')
})

test('udp: MULTI scrape using Client.scrape static method', function (t) {
  clientScrapeMulti(t, 'udp')
})

test('server: multiple info_hash scrape (manual http request)', function (t) {
  t.plan(13)

  commonTest.createServer(t, 'http', function (server, announceUrl) {
    var scrapeUrl = announceUrl.replace('/announce', '/scrape')

    var url = scrapeUrl + '?' + commonLib.querystringStringify({
      info_hash: [ binaryInfoHash1, binaryInfoHash2 ]
    })

    get.concat(url, function (err, res, data) {
      t.error(err)

      t.equal(res.statusCode, 200)

      data = bencode.decode(data)
      t.ok(data.files)
      t.equal(Object.keys(data.files).length, 2)

      t.ok(data.files[binaryInfoHash1])
      t.equal(typeof data.files[binaryInfoHash1].complete, 'number')
      t.equal(typeof data.files[binaryInfoHash1].incomplete, 'number')
      t.equal(typeof data.files[binaryInfoHash1].downloaded, 'number')

      t.ok(data.files[binaryInfoHash2])
      t.equal(typeof data.files[binaryInfoHash2].complete, 'number')
      t.equal(typeof data.files[binaryInfoHash2].incomplete, 'number')
      t.equal(typeof data.files[binaryInfoHash2].downloaded, 'number')

      server.close(function () { t.pass('server closed') })
    })
  })
})

test('server: all info_hash scrape (manual http request)', function (t) {
  t.plan(10)
  commonTest.createServer(t, 'http', function (server, announceUrl) {
    var scrapeUrl = announceUrl.replace('/announce', '/scrape')

    parsedBitlove.announce = [ announceUrl ]

    // announce a torrent to the tracker
    var client = new Client(peerId, 6881, parsedBitlove)
    client.on('error', function (err) { t.error(err) })
    client.on('warning', function (err) { t.error(err) })

    client.start()

    server.once('start', function () {
      // now do a scrape of everything by omitting the info_hash param
      get.concat(scrapeUrl, function (err, res, data) {
        t.error(err)

        t.equal(res.statusCode, 200)
        data = bencode.decode(data)
        t.ok(data.files)
        t.equal(Object.keys(data.files).length, 1)

        t.ok(data.files[binaryBitlove])
        t.equal(typeof data.files[binaryBitlove].complete, 'number')
        t.equal(typeof data.files[binaryBitlove].incomplete, 'number')
        t.equal(typeof data.files[binaryBitlove].downloaded, 'number')

        client.destroy(function () { t.pass('client destroyed') })
        server.close(function () { t.pass('server closed') })
      })
    })
  })
})
