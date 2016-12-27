var Server = require('../')

exports.createServer = function (t, opts, cb) {
  if (typeof opts === 'string') console.log('Passed string')

  var server = new Server(opts)

  server.on('error', function (err) { t.error(err) })
  server.on('warning', function (err) { t.error(err) })

  server.listen(0, function () {
    var port = server.http.address().port
    var announceUrl = 'ws://127.0.0.1:' + port

    cb(server, announceUrl)
  })
}

exports.mockWebsocketTracker = function (client) {
  client._trackers[0]._generateOffers = function (numwant, cb) {
    var offers = []
    for (var i = 0; i < numwant; i++) {
      offers.push({ fake_offer: 'fake_offer_' + i })
    }
    process.nextTick(function () {
      cb(offers)
    })
  }
}
