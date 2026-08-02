import assert from 'node:assert/strict'
import { applyExplicitOrderNotes, filterUnrequestedExtras, reconcileInitialBurgerItems } from '../src/orderRules.js'

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

console.log('Reglas de pedidos del bot verificadas.')
