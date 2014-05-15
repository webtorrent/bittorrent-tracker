var Client = require('../').Client
var fs = require('fs')
var parseTorrent = require('parse-torrent')
var test = require('tape')

var torrent = fs.readFileSync(__dirname + '/torrents/sintel-5gb.torrent')
var parsedTorrent = parseTorrent(torrent)
var peerId = new Buffer('01234567890123456789')
var port = 6881

// remove all tracker servers except a single UDP one, for now
parsedTorrent.announce = [ 'udp://tracker.publicbt.com:80/announce' ]

test('large torrent: client.start()', function (t) {
  t.plan(4)

  var client = new Client(peerId, port, parsedTorrent)

  client.on('error', function (err) {
    t.error(err)
  })

  client.once('update', function (data) {
    t.equal(data.announce, 'udp://tracker.publicbt.com:80/announce')
    t.equal(typeof data.complete, 'number')
    t.equal(typeof data.incomplete, 'number')
  })

  client.once('peer', function (addr) {
    t.pass('there is at least one peer') // TODO: this shouldn't rely on an external server!
    client.stop()
  })

  client.start()
})
