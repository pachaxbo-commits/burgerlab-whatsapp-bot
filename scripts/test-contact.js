import assert from 'node:assert/strict'
import { formatCustomerPhone, phoneFromChatId, resolveCustomerPhone } from '../src/contact.js'
import { defaultSettings } from '../src/settings.js'

assert.equal(phoneFromChatId('59162834717@s.whatsapp.net'), '59162834717')
assert.equal(phoneFromChatId('59162834717:12@s.whatsapp.net'), '59162834717')
assert.equal(phoneFromChatId('123456789012345@lid'), '')
assert.equal(phoneFromChatId('120000000000@g.us'), '')
assert.equal(resolveCustomerPhone('59162834717@s.whatsapp.net', '67688886'), '59162834717')
assert.equal(resolveCustomerPhone('123456789012345@lid', '67688886'), '59167688886')
assert.equal(formatCustomerPhone('59162834717'), '+59162834717')
assert.equal(formatCustomerPhone('67688886'), '+59167688886')
assert.equal(defaultSettings.autoSendDeliveryGroupOrders, false)

console.log('Numero real del chat y envio manual al grupo verificados.')
