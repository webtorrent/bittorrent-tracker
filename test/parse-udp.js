import common from '../lib/common.js'
import parseUdpRequest from '../lib/server/parse-udp.js'
import test from 'tape'

const rinfo = { address: '127.0.0.1', port: 6881 }

function announce (ip) {
  const msg = Buffer.alloc(98)
  Buffer.from(common.CONNECTION_ID).copy(msg, 0)
  msg.writeUInt32BE(common.ACTIONS.ANNOUNCE, 8)
  msg.writeUInt32BE(common.EVENTS.started, 80)
  msg.writeUInt32BE(ip, 84)
  return msg
}

test('udp announce: ip field sets the peer address', t => {
  const params = parseUdpRequest(announce(0x39811EB6), rinfo)
  t.equal(params.ip, '57.129.30.182')
  t.equal(params.addr, '57.129.30.182:6881')
  t.end()
})

test('udp announce: zero ip field falls back to the sender address', t => {
  const params = parseUdpRequest(announce(0), rinfo)
  t.equal(params.ip, '127.0.0.1')
  t.equal(params.addr, '127.0.0.1:6881')
  t.end()
})
