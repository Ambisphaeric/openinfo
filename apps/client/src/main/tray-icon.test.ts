import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TRAY_ICON_TEMPLATE_1X, TRAY_ICON_TEMPLATE_2X, trayIconBuffer } from './tray-icon.js'

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

test('both tray icon representations decode to valid PNG buffers', () => {
  for (const b64 of [TRAY_ICON_TEMPLATE_1X, TRAY_ICON_TEMPLATE_2X]) {
    const buf = trayIconBuffer(b64)
    assert.ok(buf.length > PNG_MAGIC.length)
    assert.ok(buf.subarray(0, 8).equals(PNG_MAGIC), 'starts with the PNG signature')
  }
})
