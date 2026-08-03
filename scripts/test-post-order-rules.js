import assert from 'node:assert/strict'
import {
  isConfirmedOrderModificationRequest,
  isConfirmedOrderStatusRequest,
  isPickupArrivalNotice,
  isPostOrderCourtesyText,
  shouldAnswerAsStandaloneQuestion,
  shouldSuppressRepeatedOrderSummary,
} from '../src/postOrderRules.js'

assert.equal(isConfirmedOrderStatusRequest('Ya salio mi pedido ???'), true)
assert.equal(isConfirmedOrderStatusRequest('Cuanto falta para mi pedido?'), true)
assert.equal(isConfirmedOrderStatusRequest('Mi pedido ya esta en camino?'), true)
assert.equal(isConfirmedOrderModificationRequest('Ya salio mi pedido ???'), false)
assert.equal(isConfirmedOrderModificationRequest('Quiero agregar tocino a mi pedido'), true)
assert.equal(isConfirmedOrderModificationRequest('Pueden cambiarlo a sin cebolla?'), true)
assert.equal(isConfirmedOrderModificationRequest('Quiero hacer otro pedido'), false)
assert.equal(isPostOrderCourtesyText('Muchas gracias, estoy pasando ahorita!'), true)
assert.equal(isPostOrderCourtesyText('Ok, ya voy a recoger'), true)
assert.equal(isPostOrderCourtesyText('Gracias!'), true)
assert.equal(isPostOrderCourtesyText('Gracias, quiero agregar tocino'), false)
assert.equal(isPostOrderCourtesyText('Gracias, cuanto falta para mi pedido?'), false)
assert.equal(isPostOrderCourtesyText('Gracias, quiero hacer otro pedido'), false)
assert.equal(isPickupArrivalNotice('Muchas gracias, estoy pasando ahorita!'), true)
assert.equal(shouldSuppressRepeatedOrderSummary('resumen A', 'resumen A', 'listo'), true)
assert.equal(shouldSuppressRepeatedOrderSummary('resumen A', 'resumen B', 'agrega tocino'), false)
assert.equal(shouldSuppressRepeatedOrderSummary('resumen A', 'resumen A', 'Mandame otra vez el resumen'), false)
assert.equal(shouldAnswerAsStandaloneQuestion({ intent: 'question' }), true)
assert.equal(shouldAnswerAsStandaloneQuestion({ intent: 'question', carriesCustomerLocation: true }), false)
assert.equal(shouldAnswerAsStandaloneQuestion({ intent: 'question', carriesConcreteOrder: true }), false)

console.log('Consultas de estado y modificaciones confirmadas se derivan en silencio.')
