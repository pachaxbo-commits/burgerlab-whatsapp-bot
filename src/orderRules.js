const NUMBER_WORDS = new Map([
  ['un', 1], ['una', 1], ['uno', 1], ['dos', 2], ['tres', 3], ['cuatro', 4],
  ['cinco', 5], ['seis', 6], ['siete', 7], ['ocho', 8], ['nueve', 9], ['diez', 10],
])

const QUANTITY_TOKEN_PATTERN = '\\d+|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez'
const BURGER_REFERENCE_PATTERN = '(?:bbq(?:\\s+lab)?|bbk(?:\\s+lab)?|bbc(?:\\s+lab)?|barbacoas?|barbakoas?|burguers?\\s*lab|burgers?\\s*lab|hamburguesas?(?:\\s+(?:de\\s+)?(?:bbq|barbacoa|barbakoa))?)'

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase()
}

function quantityFromToken(token, fallback = 1) {
  if (!token) return fallback
  const numeric = Number(token)
  if (Number.isFinite(numeric)) return Math.max(1, Math.round(numeric))
  return NUMBER_WORDS.get(normalizeText(token)) || fallback
}

function isBurgerProduct(product) {
  const id = normalizeText(product?.id)
  const name = normalizeText(product?.name)
  return product?.categoryId === 'hamburguesas' || /burger|burguer|bbq|hamburguesa/.test(`${id} ${name}`)
}

function countBurgerMentions(text) {
  return (normalizeText(text).match(new RegExp(`\\b${BURGER_REFERENCE_PATTERN}\\b`, 'g')) || []).length
}

function burgerBrand(item, catalog) {
  const product = (catalog?.products || []).find((candidate) => candidate.id === item.productId)
  const value = normalizeText(`${product?.id || ''} ${product?.name || ''} ${item.productId || ''} ${item.name || ''}`)
  return /\bbbq\b|\bbarbacoa\b|\bbarbakoa\b/.test(value) ? 'bbq' : 'burger-lab'
}

function applyExplicitBurgerQuantities(items, text, catalog) {
  const normalized = normalizeText(text)
  const pattern = new RegExp(
    `\\b(${QUANTITY_TOKEN_PATTERN})\\s+(?:de\\s+)?(?:(?:simples?|dobles?|triples?)\\s+)?(${BURGER_REFERENCE_PATTERN})\\b`,
    'g',
  )
  const mentions = Array.from(normalized.matchAll(pattern)).map((match) => ({
    brand: /bbq|bbk|bbc|barbacoa|barbakoa/.test(match[2]) ? 'bbq' : 'burger-lab',
    quantity: quantityFromToken(match[1], 1),
  }))
  if (!mentions.length) return items || []

  const corrected = (items || []).map((item) => ({ ...item }))
  for (const brand of ['bbq', 'burger-lab']) {
    const brandMentions = mentions.filter((mention) => mention.brand === brand)
    const itemIndexes = corrected
      .map((item, index) => (isBurgerProduct((catalog?.products || []).find((product) => product.id === item.productId) || item) && burgerBrand(item, catalog) === brand ? index : -1))
      .filter((index) => index >= 0)

    if (brandMentions.length === itemIndexes.length) {
      brandMentions.forEach((mention, index) => {
        corrected[itemIndexes[index]].quantity = mention.quantity
      })
    } else if (brandMentions.length === 1 && itemIndexes.length === 1) {
      corrected[itemIndexes[0]].quantity = brandMentions[0].quantity
    }
  }

  return corrected
}

function findBurgerProduct(catalog, { brand, size, withFries, price }) {
  const products = (catalog?.products || []).filter(isBurgerProduct)
  if (Number.isFinite(price)) {
    const byPrice = products.find((product) => Number(product.price) === price)
    if (byPrice) return byPrice
  }

  const expectedId = `${brand === 'bbq' ? 'bbq' : 'burger-lab'}-${size}-${withFries ? 'con' : 'sin'}-papas`
  const byId = products.find((product) => product.id === expectedId)
  if (byId) return byId

  return products.find((product) => {
    const name = normalizeText(product.name)
    const matchesBrand = brand === 'bbq' ? name.includes('bbq') : !name.includes('bbq')
    const matchesSize = size === 'doble' ? name.includes('doble') : !name.includes('doble')
    const isWithoutFries = name.includes('sin papas')
    return matchesBrand && matchesSize && isWithoutFries === !withFries
  })
}

function findQuickExtra(catalog, pattern) {
  return (catalog?.quickExtras || []).find((extra) => pattern.test(normalizeText(extra.name)))
}

function findMentionedQuickExtra(text, catalog) {
  const normalized = normalizeText(text)
  const aliases = [
    { pattern: /\btocinos?\b/, catalogPattern: /tocino/ },
    { pattern: /\bpinas?\b/, catalogPattern: /pina/ },
    { pattern: /\bquesos?(?:\s+extra)?\b/, catalogPattern: /^queso$/ },
    { pattern: /\bcarnes?\s+extra\b/, catalogPattern: /carne/ },
  ]

  const alias = aliases.find((candidate) => candidate.pattern.test(normalized))
  return alias ? findQuickExtra(catalog, alias.catalogPattern) : null
}

function requestedExtraQuantity(text, extraName) {
  const normalized = normalizeText(text)
  const name = normalizeText(extraName)
  const tokenPattern = '(\\d+|un|una|uno|dos|tres|cuatro|cinco|seis)'
  const namePattern = name.includes('pina')
    ? 'pinas?'
    : name.includes('tocino')
      ? 'tocinos?'
      : name === 'queso'
        ? 'quesos?(?:\\s+extra)?'
        : 'carnes?\\s+extra'
  const match = normalized.match(new RegExp(`\\b${tokenPattern}\\s+${namePattern}\\b`))
  if (match) return quantityFromToken(match[1], 1)
  if (new RegExp(`\\bdoble\\s+${namePattern}\\b`).test(normalized)) return 2
  return 1
}

function targetUnitIndex(text, totalUnits) {
  const normalized = normalizeText(text)
  const ordinalPatterns = [
    /\b(?:primer|primera|primero|1ra|1ro)\b/,
    /\b(?:segunda|segundo|2da|2do)\b/,
    /\b(?:tercera|tercero|3ra|3ro)\b/,
    /\b(?:cuarta|cuarto|4ta|4to)\b/,
    /\b(?:quinta|quinto|5ta|5to)\b/,
  ]
  const ordinal = ordinalPatterns.findIndex((pattern) => pattern.test(normalized))
  if (ordinal >= 0) return ordinal < totalUnits ? ordinal : -1
  if (/\b(?:ultima|ultimo)\b/.test(normalized)) return totalUnits - 1
  return -1
}

function expandTargetUnit(items, targetIndex) {
  const expanded = []
  let unitIndex = 0

  for (const item of items || []) {
    const quantity = Math.max(1, Math.round(Number(item.quantity) || 1))
    const targetInsideItem = targetIndex >= unitIndex && targetIndex < unitIndex + quantity
    if (!targetInsideItem) {
      expanded.push({ ...item, extras: [...(item.extras || [])] })
      unitIndex += quantity
      continue
    }

    const unitsBefore = targetIndex - unitIndex
    const unitsAfter = quantity - unitsBefore - 1
    if (unitsBefore > 0) expanded.push({ ...item, quantity: unitsBefore, extras: [...(item.extras || [])] })
    expanded.push({ ...item, quantity: 1, extras: [...(item.extras || [])], __targetedModification: true })
    if (unitsAfter > 0) expanded.push({ ...item, quantity: unitsAfter, extras: [...(item.extras || [])] })
    unitIndex += quantity
  }

  return expanded
}

export function applyTargetedOrderItemChange(previousItems, aiItems, text, catalog) {
  if (!previousItems?.length) return aiItems || []

  const normalized = normalizeText(text)
  const isChangeRequest = /\b(?:agrega|agregar|agregale|aumenta|aumentar|aumentale|anade|anadir|pon|pone|poner|ponle|suma|sumar|quita|quitar|saca|sacar|elimina|eliminar|borra|borrar|sin)\b/.test(normalized)
  if (!isChangeRequest) return aiItems || []

  const totalUnits = previousItems.reduce((sum, item) => sum + Math.max(1, Math.round(Number(item.quantity) || 1)), 0)
  const targetIndex = targetUnitIndex(text, totalUnits)
  const extra = findMentionedQuickExtra(text, catalog)
  if (targetIndex < 0 || !extra) return aiItems || []

  const removing = /\b(?:quita|quitar|saca|sacar|elimina|eliminar|borra|borrar|sin)\b/.test(normalized)
  const count = requestedExtraQuantity(text, extra.name)
  return expandTargetUnit(previousItems, targetIndex).map((item) => {
    if (!item.__targetedModification) return item

    const currentExtras = [...(item.extras || [])]
    let extras
    if (removing) {
      const removeAll = /\bsin\b/.test(normalized) || !new RegExp(`\\b(?:\\d+|un|una|uno|dos|tres|cuatro|cinco|seis|doble)\\b`).test(normalized)
      let remainingToRemove = removeAll ? Number.POSITIVE_INFINITY : count
      extras = currentExtras.filter((candidate) => {
        const matches = normalizeText(candidate.name) === normalizeText(extra.name)
        if (!matches || remainingToRemove <= 0) return true
        remainingToRemove -= 1
        return false
      })
    } else {
      const additions = Array.from({ length: count }, () => ({ id: extra.id, name: extra.name, price: Number(extra.price) || 0 }))
      extras = [...currentExtras, ...additions]
    }

    const { __targetedModification, ...cleanItem } = item
    return { ...cleanItem, extras }
  })
}

export function preserveItemsDuringAdditiveChange(previousItems, aiItems, text) {
  if (!previousItems?.length || !aiItems?.length) return aiItems || previousItems || []

  const normalized = normalizeText(text)
  const isAdditive = /\b(?:agrega|agregar|agregame|agregale|aumenta|aumentar|aumentame|aumentale|anade|anadir|pon|poner|ponle|suma|sumar|ademas|otra|otro)\b/.test(normalized)
  if (!isAdditive) return aiItems

  const quantityByProduct = (items) => {
    const totals = new Map()
    for (const item of items || []) {
      const key = item.productId || normalizeText(item.name)
      totals.set(key, (totals.get(key) || 0) + Math.max(1, Number(item.quantity) || 1))
    }
    return totals
  }

  const previousQuantities = quantityByProduct(previousItems)
  const nextQuantities = quantityByProduct(aiItems)
  const keepsEveryPreviousProduct = [...previousQuantities.entries()].every(
    ([key, quantity]) => (nextQuantities.get(key) || 0) >= quantity,
  )
  if (keepsEveryPreviousProduct) return aiItems

  const merged = previousItems.map((item) => ({
    ...item,
    extras: [...(item.extras || [])],
    options: [...(item.options || [])],
  }))

  for (const nextItem of aiItems) {
    const matchIndex = merged.findIndex((item) => (
      item.productId === nextItem.productId ||
      (!item.productId && normalizeText(item.name) === normalizeText(nextItem.name))
    ))
    if (matchIndex < 0) {
      merged.push(nextItem)
      continue
    }

    const previousItem = merged[matchIndex]
    const carriesModifierChange = (
      JSON.stringify(nextItem.extras || []) !== JSON.stringify(previousItem.extras || []) ||
      JSON.stringify(nextItem.options || []) !== JSON.stringify(previousItem.options || []) ||
      normalizeText(nextItem.note) !== normalizeText(previousItem.note)
    )
    if (carriesModifierChange) {
      merged[matchIndex] = {
        ...nextItem,
        quantity: Math.max(Number(previousItem.quantity) || 1, Number(nextItem.quantity) || 1),
      }
    }
  }

  return merged
}

function collectExtra(line, catalog, pattern, catalogPattern, itemQuantity) {
  const match = line.match(new RegExp(`\\b(?:(\\d+|un|una|uno|dos|tres|cuatro|cinco|seis)\\s+)?${pattern}\\b`, 'i'))
  if (!match) return { extras: [], perUnit: false }
  const extra = findQuickExtra(catalog, catalogPattern)
  if (!extra) return { extras: [], perUnit: false }

  const hasOwnQuantity = Boolean(match[1])
  const count = quantityFromToken(match[1], 1)
  return {
    extras: Array.from({ length: count }, () => ({ id: extra.id, name: extra.name, price: Number(extra.price) || 0 })),
    perUnit: !hasOwnQuantity && itemQuantity > 1,
  }
}

function parseBurgerLine(rawLine, catalog) {
  const line = normalizeText(rawLine)
  if (!new RegExp(`\\b${BURGER_REFERENCE_PATTERN}\\b`).test(line)) return null

  const quantityMatch = line.match(new RegExp(
    `\\b(${QUANTITY_TOKEN_PATTERN})\\s+(?:de\\s+)?(?:(?:simples?|dobles?|triples?)\\s+)?${BURGER_REFERENCE_PATTERN}\\b`,
  ))
  const quantity = quantityFromToken(quantityMatch?.[1], 1)
  const brand = /\b(?:bbq|bbk|bbc)\b|\b(?:barbacoa|barbakoa)s?\b/.test(line) ? 'bbq' : 'burger-lab'
  const triple = /\btriples?\b/.test(line)
  const size = /\bdobles?\b/.test(line) || triple ? 'doble' : 'simple'
  const withFries = !/\bsin\s+papas?\b/.test(line)
  const priceMatch = line.match(/\b(?:de|bs\.?|bolivianos?)\s*(19|20|22|23|34|35|37|38)\b/)
  const product = findBurgerProduct(catalog, {
    brand,
    size,
    withFries,
    price: priceMatch ? Number(priceMatch[1]) : Number.NaN,
  })
  if (!product) return null

  const requestedExtras = [
    collectExtra(line, catalog, 'pi(?:n|ñ)as?', /pina/, quantity),
    collectExtra(line, catalog, 'tocinos?', /tocino/, quantity),
    collectExtra(line, catalog, 'quesos?(?:\\s+extra)?', /^queso$/, quantity),
    collectExtra(line, catalog, 'carnes?\\s+extra', /carne/, quantity),
  ]
  const extras = requestedExtras.flatMap((entry) => entry.extras)
  const extrasForEachUnit = requestedExtras.some((entry) => entry.perUnit)
  const notes = []
  if (/\bsin\s+cebolla\b/.test(line)) notes.push('Sin cebolla')
  if (/\bsin\s+mantequilla\b/.test(line)) notes.push('Sin mantequilla')
  if (/\bsin\s+queso\b/.test(line)) notes.push('Sin queso')
  if (/\bsin\s+salsa\b/.test(line) && !/\bsin\s+salsa\s+bbq\b/.test(line)) notes.push('Sin salsa')

  return {
    productId: product.id,
    name: product.name,
    basePrice: Number(product.price) || 0,
    quantity,
    note: notes.join(', '),
    customerAskedTriple: triple,
    extrasForEachUnit,
    options: [],
    extras,
  }
}

function appendExtraFriesProduct(items, text, catalog) {
  const normalized = normalizeText(text)
  const quantityToken = '(\\d+|un|una|uno|dos|tres|cuatro|cinco|seis)'
  const match = normalized.match(new RegExp(
    `\\b(?:${quantityToken}\\s+)?(?:porcion|racion)\\s+(?:extra\\s+de\\s+|de\\s+)?papas\\b|\\b(?:${quantityToken}\\s+)?papas\\s+extra\\b`,
  ))
  if (!match) return items || []

  const product = (catalog?.products || []).find((candidate) => {
    const name = normalizeText(candidate.name)
    return !isBurgerProduct(candidate) && /papas/.test(name) && /extra|porcion|racion/.test(name)
  })
  if (!product) return items || []

  const quantity = quantityFromToken(match[1] || match[2], 1)
  const matchesProduct = (item) => (
    item.productId === product.id || normalizeText(item.name) === normalizeText(product.name)
  )
  const existing = (items || []).find(matchesProduct)
  if (existing) {
    return (items || []).map((item) => matchesProduct(item)
      ? { ...item, quantity: Math.max(Number(item.quantity) || 1, quantity) }
      : item)
  }

  return [
    ...(items || []),
    {
      productId: product.id,
      name: product.name,
      basePrice: Number(product.price) || 0,
      quantity,
      note: '',
      customerAskedTriple: false,
      extrasForEachUnit: false,
      options: [],
      extras: [],
    },
  ]
}

export function reconcileInitialBurgerItems(aiItems, text, catalog) {
  const quantityCorrectedItems = applyExplicitBurgerQuantities(aiItems || [], text, catalog)
  const mentions = countBurgerMentions(text)
  if (!mentions) return appendExtraFriesProduct(quantityCorrectedItems, text, catalog)

  const parsed = String(text || '')
    .split(/\r?\n/)
    .map((line) => parseBurgerLine(line, catalog))
    .filter(Boolean)

  // A sentence containing several burgers is left to the model; the deterministic parser is
  // intentionally used only when every mentioned burger maps to one unambiguous line.
  if (!parsed.length || parsed.length !== mentions) return appendExtraFriesProduct(quantityCorrectedItems, text, catalog)

  const nonBurgerItems = quantityCorrectedItems.filter((item) => {
    const product = (catalog?.products || []).find((candidate) => candidate.id === item.productId)
    return !isBurgerProduct(product || item)
  })
  return appendExtraFriesProduct([...parsed, ...nonBurgerItems], text, catalog)
}

function extraWasAlreadyPresent(previousItems, item, extra) {
  const previous = (previousItems || []).find((candidate) => candidate.productId === item.productId)
  return Boolean(previous?.extras?.some((candidate) => normalizeText(candidate.name) === normalizeText(extra.name)))
}

function extraMentioned(text, extraName) {
  const normalized = normalizeText(text)
  const name = normalizeText(extraName)
  if (name.includes('pina')) return /\bpinas?\b/.test(normalized)
  if (name.includes('tocino')) return /\btocinos?\b/.test(normalized)
  if (name === 'queso') return /\bquesos?\b/.test(normalized)
  if (name.includes('carne')) return /\bcarne\s+extra\b|\btriples?\b/.test(normalized)
  if (name.includes('golf')) return /\bgolf\b/.test(normalized)
  if (name.includes('bbq')) return /\bsalsa\s+bbq\b/.test(normalized)
  return normalized.includes(name)
}

function extraExplicitlyRemoved(text, extraName) {
  const normalized = normalizeText(text)
  const name = normalizeText(extraName)
  return new RegExp(`\\b(?:quita|quitar|saca|sacar|elimina|eliminar|borra|borrar|sin)\\b[^.\\n]{0,35}\\b${name}\\b`).test(normalized)
}

export function filterUnrequestedExtras(previousItems, items, text) {
  return (items || []).map((item) => ({
    ...item,
    extras: (item.extras || []).filter((extra) => {
      if (extraExplicitlyRemoved(text, extra.name)) return false
      return extraWasAlreadyPresent(previousItems, item, extra) || extraMentioned(text, extra.name)
    }),
  }))
}

function spicySauceCount(text) {
  const normalized = normalizeText(text)
  const explicit = normalized.match(/\b(?:(\d+|un|una|dos|tres|cuatro|cinco)\s+)?salsas?\s+(?:picantes?|verdes?)(?:\s+extra)?\b/)
  if (explicit) return quantityFromToken(explicit[1], 1)
  const llajua = normalized.match(/\b(?:(\d+|un|una|dos|tres|cuatro|cinco)\s+)?llajuas?\b/)
  if (llajua) return quantityFromToken(llajua[1], 1)
  const generic = normalized.match(/\b(?:(\d+|un|una|dos|tres|cuatro|cinco)\s+)?salsas?\s+extra\b/)
  if (generic && !/\b(golf|bbq|barbacoa)\b/.test(normalized)) return quantityFromToken(generic[1], 1)
  return 0
}

function appendNote(note, addition) {
  const current = String(note || '').trim()
  if (!current) return addition
  if (normalizeText(current).includes(normalizeText(addition))) return current
  return `${current}, ${addition}`
}

export function applyExplicitOrderNotes(items, text) {
  let nextItems = [...(items || [])]
  const normalized = normalizeText(text)

  if (/\b(?:quita|quitar|saca|sacar|elimina|eliminar|borra|borrar)\b[^.\n]{0,45}\bqueso\b/.test(normalized)) {
    nextItems = nextItems
      .filter((item) => !/sandwich\s+de\s+queso/.test(normalizeText(item.name)))
      .map((item) => ({
        ...item,
        extras: (item.extras || []).filter((extra) => normalizeText(extra.name) !== 'queso'),
      }))
  }

  const sauceCount = spicySauceCount(text)
  if (!sauceCount) return nextItems

  // Llajua/salsa picante is free and belongs in the kitchen note, never as a paid catalog item.
  nextItems = nextItems.filter((item) => !/salsa\s+(?:verde|picante)/.test(normalizeText(item.name)))
  if (!nextItems.length) return nextItems

  const targetIndex = Math.max(0, nextItems.findIndex((item) => /burger|burguer|bbq/.test(normalizeText(item.name))))
  const label = `${sauceCount} ${sauceCount === 1 ? 'salsa picante extra' : 'salsas picantes extra'} (gratis)`
  nextItems[targetIndex] = {
    ...nextItems[targetIndex],
    note: appendNote(nextItems[targetIndex].note, label),
    extras: (nextItems[targetIndex].extras || []).filter((extra) => !/salsa\s+(?:verde|picante)/.test(normalizeText(extra.name))),
  }
  return nextItems
}

