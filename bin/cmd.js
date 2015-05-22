#!/usr/bin/env node

var minimist = require('minimist')
var Server = require('../').Server

var argv = minimist(process.argv.slice(2), {
  alias: {
    h: 'help',
    p: 'port',
    q: 'quiet',
    s: 'silent',
    v: 'version'
  },
  boolean: [
    'help',
    'http',
    'quiet',
    'silent',
    'trust-proxy',
    'udp',
    'version',
    'ws'
  ],
  default: {
    http: true,
    port: 8000,
    udp: true,
    ws: false
  }
})

if (argv.version) {
  console.log(require('../package.json').version)
  process.exit(0)
}

if (argv.help) {
  console.log(function () {
  /*
  bittorrent-tracker - Start a bittorrent tracker server

  Usage:
      bittorrent-tracker

  Options:
      -p, --port [number]     change the port [default: 8000]
          --trust-proxy       trust 'x-forwarded-for' header from reverse proxy
          --interval          tell clients to announce on this interval (ms)
          --http              enable http server [default: true]
          --udp               enable udp server [default: true]
          --ws                enable websocket server [default: false]
      -q, --quiet             only show error output
      -s, --silent            show no output
      -v, --version           print the current version

  Please report bugs!  https://github.com/feross/bittorrent-tracker/issues

  */
  }.toString().split(/\n/).slice(2, -2).join('\n'))
  process.exit(0)
}

if (argv.silent) argv.quiet = true

var server = new Server({
  http: argv.http,
  interval: argv.interval,
  trustProxy: argv['trust-proxy'],
  udp: argv.udp,
  ws: argv.ws
})

server.on('error', function (err) {
  if (!argv.silent) console.error('ERROR: ' + err.message)
})
server.on('warning', function (err) {
  if (!argv.quiet) console.log('WARNING: ' + err.message)
})
server.on('update', function (addr) {
  if (!argv.quiet) console.log('update: ' + addr)
})
server.on('complete', function (addr) {
  if (!argv.quiet) console.log('complete: ' + addr)
})
server.on('start', function (addr) {
  if (!argv.quiet) console.log('start: ' + addr)
})
server.on('stop', function (addr) {
  if (!argv.quiet) console.log('stop: ' + addr)
})

server.listen(argv.port, function () {
  if (server.http && !argv.quiet) {
    console.log('HTTP tracker: http://localhost:' + server.http.address().port + '/announce')
  }
  if (server.udp && !argv.quiet) {
    console.log('UDP tracker: udp://localhost:' + server.udp.address().port)
  }
  if (server.ws && !argv.quiet) {
    console.log('WebSocket tracker: ws://localhost:' + server.http.address().port)
  }
})
