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
    port: 8000
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
    bittorrent-tracker [OPTIONS]

  If no --http, --udp, or --ws option is supplied, all tracker types will be started.

  Options:
    -p, --port [number]  change the port [default: 8000]
        --trust-proxy    trust 'x-forwarded-for' header from reverse proxy
        --interval       client announce interval (ms) [default: 600000]
        --http           enable http server
        --udp            enable udp server
        --ws             enable websocket server
    -q, --quiet          only show error output
    -s, --silent         show no output
    -v, --version        print the current version

  Please report bugs!  https://github.com/feross/bittorrent-tracker/issues

  */
  }.toString().split(/\n/).slice(2, -2).join('\n'))
  process.exit(0)
}

if (argv.silent) argv.quiet = true

var allFalsy = !argv.http && !argv.udp && !argv.ws

argv.http = allFalsy || argv.http
argv.udp = allFalsy || argv.udp
argv.ws = allFalsy || argv.ws

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
  if (server.http && argv.http && !argv.quiet) {
    console.log('HTTP tracker: http://localhost:' + server.http.address().port + '/announce')
  }
  if (server.udp && !argv.quiet) {
    console.log('UDP tracker: udp://localhost:' + server.udp.address().port)
  }
  if (server.ws && !argv.quiet) {
    console.log('WebSocket tracker: ws://localhost:' + server.http.address().port)
  }
})
