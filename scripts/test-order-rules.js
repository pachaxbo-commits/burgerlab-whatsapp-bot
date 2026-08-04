import assert from 'node:assert/strict'
import { applyExplicitOrderNotes, applyTargetedOrderItemChange, filterUnrequestedExtras, preserveItemsDuringAdditiveChange, reconcileInitialBurgerItems } from '../src/orderRules.js'

const catalog = {
  products: [
    ['burger-lab-simple-con-papas', 'Burger Lab Simple Con Papas', 22],
    ['burger-lab-simple-sin-papas', 'Burger Lab Simple Sin Papas', 19],
    ['burger-lab-doble-con-papas', 'Burger Lab DOBLE Con Papas', 37],
    ['burger-lab-doble-sin-papas', 'Burger Lab DOBLE Sin Papas', 34],
    ['bbq-simple-con-papas', 'BBQ Simple Con Papas', 23],
    ['bbq-simple-sin-papas', 'BBQ Simple Sin Papas', 20],
    ['bbq-doble-con-papas', 'BBQ DOBLE Con Papas', 38],
    ['bbq-doble-sin-papas', 'BBQ DOBLE Sin Papas', 35],
  ].map(([id, name, price]) => ({ id, name, price, categoryId: 'hamburguesas', extras: [] })),
  quickExtras: [
    { id: 'pina', name: 'Pina', price: 2 },
    { id: 'tocino', name: 'Tocino', price: 4 },
    { id: 'queso', name: 'Queso', price: 3 },
    { id: 'carne-extra', name: 'Carne extra', price: 15 },
  ],
}
catalog.products.push({
  id: 'porcion-papas-extra',
  name: 'Porcion de Papas Extra',
  price: 6,
  categoryId: 'extras',
  extras: [],
})

const structured = reconcileInitialBurgerItems([], [
  '1 bbq lab doble con 2 pinas y papa',
  '2 bbq lab doble con pina, con papa',
  '1 bbq lab simple con pina, con papa',
  '3 burger lab simples con papa',
].join('\n'), catalog)

assert.equal(structured.length, 4)
assert.deepEqual(structured.map((item) => item.quantity), [1, 2, 1, 3])
assert.deepEqual(structured.map((item) => item.productId), [
  'bbq-doble-con-papas',
  'bbq-doble-con-papas',
  'bbq-simple-con-papas',
  'burger-lab-simple-con-papas',
])
assert.deepEqual(structured.map((item) => item.extras.length), [2, 1, 1, 0])
assert.equal(structured[1].extrasForEachUnit, true)

const byPrice = reconcileInitialBurgerItems([], 'Quiero una Burger Lab de 19', catalog)
assert.equal(byPrice[0].productId, 'burger-lab-simple-sin-papas')

const twoBbqNatural = reconcileInitialBurgerItems([
  { productId: 'bbq-simple-con-papas', name: 'BBQ Simple Con Papas', basePrice: 23, quantity: 1, extras: [] },
], 'Quiero dos BBQ con papas', catalog)
assert.equal(twoBbqNatural[0].quantity, 2)
assert.equal(twoBbqNatural[0].productId, 'bbq-simple-con-papas')

const twoBarbecue = reconcileInitialBurgerItems([
  { productId: 'bbq-simple-con-papas', name: 'BBQ Simple Con Papas', basePrice: 23, quantity: 1, extras: [] },
], 'Me da dos de barbacoa con papas', catalog)
assert.equal(twoBarbecue[0].quantity, 2)
assert.equal(twoBarbecue[0].productId, 'bbq-simple-con-papas')

const mixedNaturalQuantities = reconcileInitialBurgerItems([
  { productId: 'bbq-simple-con-papas', name: 'BBQ Simple Con Papas', basePrice: 23, quantity: 1, extras: [] },
  { productId: 'burger-lab-simple-con-papas', name: 'Burger Lab Simple Con Papas', basePrice: 22, quantity: 1, extras: [] },
], 'Quiero dos BBQ y una Burger Lab, todas con papas', catalog)
assert.deepEqual(mixedNaturalQuantities.map((item) => item.quantity), [2, 1])

const directUnstructuredOrder = reconcileInitialBurgerItems([], [
  'Buenas noches disculpe quisiera realizar el siguiente pedido:',
  'Raul Uzcategui',
  'Delivery',
  '75465807',
  '2 burgers lab doble con papas + 1 porcion extra de papas',
].join('\n'), catalog)
assert.deepEqual(directUnstructuredOrder.map((item) => item.productId), [
  'burger-lab-doble-con-papas',
  'porcion-papas-extra',
])
assert.deepEqual(directUnstructuredOrder.map((item) => item.quantity), [2, 1])
assert.equal(directUnstructuredOrder.reduce((sum, item) => sum + item.basePrice * item.quantity, 0), 80)

const filtered = filterUnrequestedExtras([], [{
  productId: 'burger-lab-simple-con-papas',
  name: 'Burger Lab Simple Con Papas',
  extras: [{ id: 'queso', name: 'Queso', price: 3 }],
}], 'Dos salsas picantes extra')
assert.equal(filtered[0].extras.length, 0)

const withSauce = applyExplicitOrderNotes(filtered, 'Dos salsas picantes extra')
assert.match(withSauce[0].note, /2 salsas picantes extra \(gratis\)/)

const withoutCheese = applyExplicitOrderNotes([{ ...filtered[0], extras: [{ id: 'queso', name: 'Queso', price: 3 }] }], 'No, borra todo lo del queso')
assert.equal(withoutCheese[0].extras.length, 0)

const existingOrder = [
  { productId: 'burger-lab-doble-con-papas', name: 'Burger Lab DOBLE Con Papas', basePrice: 37, quantity: 1, extras: [{ id: 'tocino', name: 'Tocino', price: 4 }] },
  { productId: 'bbq-doble-con-papas', name: 'BBQ DOBLE Con Papas', basePrice: 38, quantity: 1, extras: [{ id: 'pina', name: 'Pina', price: 2 }] },
  { productId: 'bbq-doble-con-papas', name: 'BBQ DOBLE Con Papas', basePrice: 38, quantity: 1, extras: [{ id: 'tocino', name: 'Tocino', price: 4 }] },
]
const changedFirst = applyTargetedOrderItemChange(
  existingOrder,
  [{ productId: 'burger-lab-simple-con-papas', name: 'Burger Lab Simple Con Papas', basePrice: 22, quantity: 1, extras: [{ id: 'tocino', name: 'Tocino', price: 4 }] }],
  'A la primer hamburguesa aumentar un tocino mas',
  catalog,
)
assert.equal(changedFirst.length, 3)
assert.deepEqual(changedFirst.map((item) => item.productId), existingOrder.map((item) => item.productId))
assert.equal(changedFirst[0].extras.filter((extra) => extra.id === 'tocino').length, 2)
assert.equal(changedFirst[1].extras.length, 1)
assert.equal(changedFirst[2].extras.length, 1)

const groupedOrder = [{
  productId: 'burger-lab-simple-con-papas',
  name: 'Burger Lab Simple Con Papas',
  basePrice: 22,
  quantity: 3,
  extras: [],
}]
const changedSecond = applyTargetedOrderItemChange(groupedOrder, [], 'Ponle tocino a la segunda hamburguesa', catalog)
assert.deepEqual(changedSecond.map((item) => item.quantity), [1, 1, 1])
assert.equal(changedSecond[0].extras.length, 0)
assert.equal(changedSecond[1].extras[0].id, 'tocino')
assert.equal(changedSecond[2].extras.length, 0)

const partialAddition = preserveItemsDuringAdditiveChange(existingOrder, [{
  productId: 'coca-cola-300-ml',
  name: 'Coca Cola 300 ml',
  basePrice: 5,
  quantity: 1,
  extras: [],
}], 'Agregame una Coca Cola')
assert.equal(partialAddition.length, 4)
assert.deepEqual(partialAddition.slice(0, 3).map((item) => item.productId), existingOrder.map((item) => item.productId))
assert.equal(partialAddition[3].productId, 'coca-cola-300-ml')

const partialModifier = preserveItemsDuringAdditiveChange(existingOrder, [{
  ...existingOrder[1],
  extras: [...existingOrder[1].extras, { id: 'tocino', name: 'Tocino', price: 4 }],
}], 'Agregale tocino a la BBQ con pina')
assert.equal(partialModifier.length, 3)
assert.equal(partialModifier[1].extras.length, 2)
assert.equal(partialModifier[2].extras.length, 1)

console.log('Reglas de pedidos del bot verificadas.')
