import assert from 'node:assert/strict'
import {
  isConfirmedOrderModificationRequest,
  isConfirmedOrderStatusRequest,
  shouldSuppressRepeatedOrderSummary,
} from '../src/postOrderRules.js'

assert.equal(isConfirmedOrderStatusRequest('Ya salio mi pedido ???'), true)
assert.equal(isConfirmedOrderStatusRequest('Cuanto falta para mi pedido?'), true)
assert.equal(isConfirmedOrderStatusRequest('Mi pedido ya esta en camino?'), true)
assert.equal(isConfirmedOrderModificationRequest('Ya salio mi pedido ???'), false)
assert.equal(isConfirmedOrderModificationRequest('Quiero agregar tocino a mi pedido'), true)
assert.equal(isConfirmedOrderModificationRequest('Pueden cambiarlo a sin cebolla?'), true)
assert.equal(isConfirmedOrderModificationRequest('Quiero hacer otro pedido'), false)
assert.equal(shouldSuppressRepeatedOrderSummary('resumen A', 'resumen A', 'listo'), true)
assert.equal(shouldSuppressRepeatedOrderSummary('resumen A', 'resumen B', 'agrega tocino'), false)
assert.equal(shouldSuppressRepeatedOrderSummary('resumen A', 'resumen A', 'Mandame otra vez el resumen'), false)

console.log('Consultas de estado y modificaciones confirmadas se derivan en silencio.')
