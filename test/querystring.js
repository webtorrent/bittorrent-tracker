import common from '../lib/common.js'
import test from 'tape'

// https://github.com/webtorrent/webtorrent/issues/196
test('encode special chars +* in http tracker urls', t => {
  const q = Object.create(null)
  q.info_hash = Buffer.from('a2a15537542b22925ad10486bf7a8b2a9c42f0d1', 'hex').toString('binary')

  const encoded = 'info_hash=%A2%A1U7T%2B%22%92Z%D1%04%86%BFz%8B%2A%9CB%F0%D1'
  t.equal(common.querystringStringify(q), encoded)

  // sanity check that encode-decode matches up
  t.deepEqual(common.querystringParse(common.querystringStringify(q)), q)

  t.end()
})
