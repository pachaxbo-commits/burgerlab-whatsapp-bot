function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase()
}

export function isConfirmedOrderStatusRequest(text) {
  const normalized = normalizeText(text)
  return (
    /\b(?:ya\s+)?(?:salio|despacharon|despachado|esta\s+list[oa]|esta\s+en\s+camino|llego|llega)\b/.test(normalized) ||
    /\b(?:cuanto\s+falta|cuando\s+sale|a\s+que\s+hora\s+sale|donde\s+esta)\b/.test(normalized)
  )
}

export function isConfirmedOrderModificationRequest(text) {
  const normalized = normalizeText(text)
  return /\b(?:agreg(?:ar|ame|ale)|aument(?:ar|ame|ale)|cambi(?:ar(?:lo|la)?|ame|ale)|sac(?:ar|ame|ale)|quit(?:ar|ame|ale)|modific(?:ar(?:lo|la)?|ame)|anad(?:ir|eme)|elimin(?:ar|a)|borr(?:ar|a))\b/.test(normalized)
}

export function isPickupArrivalNotice(text) {
  const normalized = normalizeText(text)
  return (
    /\b(?:ya\s+)?(?:estoy\s+)?(?:pasando|yendo|voy)(?:\s+(?:ahora|ahorita|en\s+camino|a\s+recoger|para\s+alla))?\b/.test(normalized) ||
    /\b(?:paso|pasare)\s+(?:ahora|ahorita|en\s+un\s+rato|a\s+recoger)\b/.test(normalized)
  )
}

/** Cierre amable posterior al pedido, sin confundir preguntas, cambios ni pedidos nuevos. */
export function isPostOrderCourtesyText(text) {
  const normalized = normalizeText(text)
  if (!normalized || /\?/.test(text)) return false
  if (isConfirmedOrderStatusRequest(normalized) || isConfirmedOrderModificationRequest(normalized)) return false

  const asksSomething = /\b(?:cuanto|cuando|donde|como|puedo|podria|tienen|hay|precio|costo)\b/.test(normalized)
  if (asksSomething) return false

  const arrivalNotice = isPickupArrivalNotice(normalized)
  const startsNewOrder = /\b(?:quiero|quisiera|necesito|dame|mandame|hacer\s+otro\s+pedido|pedido\s+nuevo|otro\s+pedido)\b/.test(normalized)
  if (startsNewOrder && !arrivalNotice) return false

  const hasThanks = /\b(?:gracias|agradezco|agradecido|agradecida)\b/.test(normalized)
  const simpleAcknowledgement = /^(?:ok|okay|listo|perfecto|dale|entendido|claro|correcto|si|sip|sale|ya)(?:\s+gracias)?[!.]*$/.test(normalized)

  return hasThanks || simpleAcknowledgement || arrivalNotice
}

export function shouldSuppressRepeatedOrderSummary(previousSummary, nextSummary, customerText = '') {
  if (!previousSummary || previousSummary !== nextSummary) return false

  const normalized = normalizeText(customerText)
  const explicitlyAskedToRepeat = (
    /\b(?:repite|repetir|reenvia|reenviame|vuelve\s+a\s+mandar|manda(?:me)?\s+otra\s+vez)\b/.test(normalized) &&
    /\b(?:resumen|pedido)\b/.test(normalized)
  )

  return !explicitlyAskedToRepeat
}

export function shouldAnswerAsStandaloneQuestion({
  intent,
  itemCount = 0,
  carriesCustomerLocation = false,
  carriesConcreteOrder = false,
}) {
  return (
    intent === 'question' &&
    itemCount === 0 &&
    !carriesCustomerLocation &&
    !carriesConcreteOrder
  )
}

/**
 * Una consulta hecha mientras se espera la confirmacion no puede reinterpretar los productos.
 * La IA a veces devuelve el borrador completo aun cuando el cliente solo pregunta por tiempo;
 * esta clasificacion usa exclusivamente el mensaje nuevo para mantener el pedido inmutable.
 */
export function isNonEditingOrderQuestion(text) {
  const normalized = normalizeText(text)
  if (!normalized) return false
  if (isConfirmedOrderModificationRequest(normalized)) return false

  return (
    /\?/.test(String(text || '')) ||
    /\b(?:cuanto|cuando|donde|como|cual|tienen|hay|puedo|podria)\b/.test(normalized) ||
    /\b(?:en\s+)?q(?:ue)?\s+(?:tiempo|hora|momento)\b/.test(normalized)
  )
}

export function isPreparationTimeQuestion(text) {
  const normalized = normalizeText(text)
  return (
    /\b(?:en\s+)?q(?:ue)?\s+tiempo\b/.test(normalized) ||
    /\bcuanto\s+(?:tiempo\s+)?(?:tarda|demora|falta)\b/.test(normalized) ||
    /\bcuando\s+(?:estaria|esta|sale|estara|queda)\b/.test(normalized) ||
    /\ba\s+que\s+hora\s+(?:estaria|esta|sale|estara|queda)\b/.test(normalized)
  )
}
