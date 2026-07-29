import { GoogleGenAI } from '@google/genai'
import { z } from 'zod'
import { config } from './config.js'
import { getSettings } from './settings.js'

let geminiClient = null

const nullableEnum = (values) =>
  z.preprocess((value) => {
    if (value === 'null' || value === '' || value === undefined) return null
    return value
  }, z.enum(values).nullable().default(null))

const numberOrDefault = (fallback) =>
  z.preprocess((value) => {
    const num = Number(value)
    return Number.isFinite(num) ? num : fallback
  }, z.number())

const orderSchema = z.object({
  intent: z.enum(['greeting', 'question', 'menu_request', 'order_draft', 'order_ready', 'confirm_order', 'cancel_order', 'delivery_pricing', 'payment_qr_request', 'human_help', 'other']),
  reply: z.string(),
  // La IA avisa cuando prefiere que conteste una persona en vez de arriesgar una respuesta mala.
  needsHuman: z.boolean().default(false),
  missingFields: z.array(z.string()).default([]),
  customerName: z.string().default(''),
  customerPhone: z.string().default(''),
  paymentMethod: nullableEnum(['cash', 'qr', 'mixed']),
  fulfillmentType: nullableEnum(['pickup', 'delivery']),
  deliveryAddress: z.string().default(''),
  items: z
    .array(
      z.object({
        productId: z.string(),
        name: z.string(),
        basePrice: numberOrDefault(0),
        quantity: numberOrDefault(1).transform((value) => (value > 0 ? Math.round(value) : 1)),
        note: z.string().default(''),
        // true solo si el cliente escribio "triple" para ESE item. Es una pregunta sobre lo que
        // dijo el cliente, no sobre el producto elegido: se probo con un campo "tamaño" y el
        // modelo respondia "doble", que es el producto que termina usando una triple.
        customerAskedTriple: z.boolean().default(false),
        // true = los adicionales de este item van uno POR CADA unidad; false = son el total.
        // Depende de como lo escribio el cliente, no de una regla fija, asi que lo decide la IA.
        extrasForEachUnit: z.boolean().default(false),
        options: z.array(z.string()).default([]),
        extras: z.array(z.object({ id: z.string(), name: z.string(), price: numberOrDefault(0) })).default([]),
      }),
    )
    .default([]),
})

function buildEmptyAiResult() {
  return {
    intent: 'order_draft',
    reply: '',
    needsHuman: false,
    missingFields: [],
    customerName: '',
    customerPhone: '',
    paymentMethod: null,
    fulfillmentType: null,
    deliveryAddress: '',
    items: [],
  }
}

export async function understandMessage({ message, conversation, catalog, currentDraft }) {
  const prompt = buildPrompt({ message, conversation, catalog, currentDraft })
  let text = '{}'
  if (config.openaiApiKey) {
    try {
      text = await generateOpenAiWithRetry(prompt)
    } catch (openaiError) {
      console.error('Error llamando a OpenAI API:', openaiError)
      if (config.geminiApiKey) {
        text = (await generateContentWithRetry(prompt)).text || '{}'
      } else {
        return buildEmptyAiResult()
      }
    }
  } else if (config.geminiApiKey) {
    try {
      text = (await generateContentWithRetry(prompt)).text || '{}'
    } catch (geminiError) {
      console.error('Error llamando a Gemini API:', geminiError)
      return buildEmptyAiResult()
    }
  }

  try {
    const rawObject = JSON.parse(text || '{}')
    if (Array.isArray(rawObject.items)) {
      rawObject.items = rawObject.items.map((item) => ({
        ...item,
        extras: Array.isArray(item.extras) ? item.extras : [],
        options: Array.isArray(item.options) ? item.options : [],
        quantity: Math.min(Math.max(Number(item.quantity || 1), 1), 20),
      }))
    }
    return orderSchema.parse(rawObject)
  } catch (parseError) {
    console.error('Error parseando o validando JSON de la IA:', parseError)
    return buildEmptyAiResult()
  }
}

async function generateOpenAiWithRetry(prompt) {
  try {
    return await generateOpenAi(prompt)
  } catch (error) {
    if (!isTemporaryOpenAiError(error)) throw error
    await new Promise((resolve) => setTimeout(resolve, 700))
    return generateOpenAi(prompt)
  }
}

async function generateOpenAi(prompt) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.openaiModel,
      // Extraer un pedido no es una tarea creativa: con temperatura alta el MISMO mensaje a veces
      // devolvia los productos y a veces ninguno. En 0 la respuesta es estable.
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'Eres un extractor y asistente de pedidos de restaurante. Responde solo JSON valido.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
    }),
  })

  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(body?.error?.message || `OpenAI error ${response.status}`)
    error.status = response.status
    throw error
  }

  return body?.choices?.[0]?.message?.content || '{}'
}

function isTemporaryOpenAiError(error) {
  const status = Number(error?.status || error?.code || 0)
  const message = String(error?.message || '')
  return status === 408 || status === 409 || status === 429 || status >= 500 || /rate|timeout|temporarily|overloaded/i.test(message)
}

async function generateContentWithRetry(prompt) {
  try {
    return await generateContent(prompt)
  } catch (error) {
    if (!isTemporaryGeminiError(error)) throw error
    await new Promise((resolve) => setTimeout(resolve, 900))
    return generateContent(prompt)
  }
}

function generateContent(prompt) {
  if (!geminiClient) {
    geminiClient = new GoogleGenAI({ apiKey: config.geminiApiKey })
  }

  return geminiClient.models.generateContent({
    model: config.geminiModel,
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      temperature: 0.4,
    },
  })
}

function isTemporaryGeminiError(error) {
  const status = Number(error?.status || error?.code || 0)
  const message = String(error?.message || '')
  return status === 429 || status === 500 || status === 503 || /UNAVAILABLE|high demand|quota|rate/i.test(message)
}

function buildPrompt({ message, conversation, catalog, currentDraft }) {
  const catalogLines = catalog.products
    .map((product) => {
      // Combina los extras del producto y los quickExtras globales (solo para hamburguesas)
      const allExtras = [...(product.extras || [])]
      if (product.categoryId === 'hamburguesas' && Array.isArray(catalog.quickExtras)) {
        catalog.quickExtras.forEach((qe) => {
          if (!allExtras.some((e) => e.id === qe.id)) {
            allExtras.push(qe)
          }
        })
      }
      // El id de cada extra TIENE que ir aca. El esquema obliga a devolver un id por extra, y si
      // esta lista no lo trae, el unico lugar del catalogo donde el modelo encuentra ids son los
      // productos - incluida una categoria de productos que se llama literalmente "Extras"
      // (Sandwich de queso/huevo, Salsa verde/picante). Ahi termina sacandolos: a un cliente que
      // pidio "doble porcion de queso extra y una porcion de piña" le registro "Sandwich de
      // queso/huevo" x2 y "Salsa verde/picante".
      const extras = allExtras.length
        ? ` Extras/Adicionales disponibles (usa EXACTAMENTE estos id): ${allExtras.map((extra) => `id=${extra.id} (${extra.name}, +${extra.price})`).join('; ')}.`
        : ''
      return `- id=${product.id}; ${product.name}; precio=${product.price}; categoria=${product.categoryId}.${extras}`
    })
    .join('\n')

  return `
Eres el bot de WhatsApp de ${config.businessName}.
Personalidad: ${getSettings().personality || config.personality}

Objetivo:
- Responder natural, corto y claro.
- Ayudar al cliente a registrar un pedido.
- No inventar productos ni precios; usa solo el catalogo. Si el cliente pide algo que NO esta en el catalogo (ej. "pizza", un producto que no existe), NO lo agregues a items, pero mencionalo en el reply avisando que ese producto no esta disponible (ej. "No tenemos pizza en el menu, pero sí registre tu hamburguesa") - no lo ignores en silencio.
- Si el cliente saluda o hace una pregunta normal del negocio, responde de forma amigable y ofrece tomar el pedido.
- Si el cliente pregunta cuánto cuesta el delivery/envio/tarifa, devuelve intent="delivery_pricing".
- Si el cliente quiere pagar por QR o pide QR/comprobante, devuelve intent="payment_qr_request".
- Si el cliente pide ver el menú, la carta, los productos o precios disponibles (incluso con errores de tipeo o frases raras como "mandame el menu", "el me u", "que tienen"), devuelve intent="menu_request". El sistema le manda la imagen real del menú automáticamente - en el campo "reply" NO listes tú los productos ni inventes tu propia versión del menú.
- Si el cliente hace preguntas NORMALES del negocio (horario de atencion, ubicacion, metodos de pago, que trae tal producto, si hacen envios, etc.) devuelve intent="question" y RESPONDELA de forma directa y util en el campo reply - esto aplica SIEMPRE, incluso si hay un pedido en curso o pendiente de confirmar. NUNCA uses intent="human_help" para preguntas normales del negocio, aunque interrumpan el flujo del pedido.
- Usa intent="human_help" UNICAMENTE para casos genuinamente problematicos: mensajes incoherentes/sin sentido, groseros/ofensivos, temas completamente ajenos al restaurante (no comida ni pedidos), o pedidos especiales que de verdad requieren que un humano decida (ej. reclamos, quejas sobre un pedido anterior, pedidos de facturacion). En estos casos el reply que escribas NO se le manda al cliente (el sistema avisa a los duenos en su lugar), asi que si dudas entre "question" y "human_help", elegi "question" y responde de forma util.
- NUNCA improvises ni redactes tú mismo el formato/estructura de datos que se le pide al cliente (nombre, celular, entrega, pedido) en el campo "reply". Si el cliente necesita ese formato (porque quiere pedir pero aun no dio todos los datos, o no diste con items claros), devuelve intent="order_draft" con items vacío o incompleto y deja missingFields indicando lo que falta - el sistema se encarga de mandarle el formato/ejemplo correcto siempre igual, tu "reply" en ese caso no se usa.
- El método de pago NO es un dato obligatorio: si el cliente no menciona "QR" en ningún momento, asume que paga en efectivo (paymentMethod="cash") y NO se lo preguntes. Solo si el cliente escribe explícitamente que quiere pagar por QR, usa paymentMethod="qr".
- El número de celular SÍ es un dato obligatorio (customerPhone). Si el cliente no lo dio, indícalo en missingFields.
- Si el cliente NO usa la plantilla o envía sus datos en varios mensajes informales, PROCESA E INFIERE IGUALMENTE toda la información que el cliente vaya dando paso a paso sin exigir obligatoriamente la plantilla.
- No crees el pedido hasta tener los datos requeridos (nombre, numero de celular, items del catálogo y tipo de entrega).
- Si el cliente pide extras/adicionales (ej. "con extra de queso", "salsa golf adicional"), agrégalos a la lista "extras" de ese item con el id, name y price exactos que figuran en el catálogo.
- Si pide varias unidades de un mismo extra (ej. "2 de salsa golf", "con doble de salsa bbq", "doble porción de tocino extra", "2 porciones de papas extra"), agrega ese extra múltiples veces en la lista "extras" del item correspondiente (tantas veces como se haya pedido: "doble"/"2" = 2 elementos iguales, "triple"/"3" = 3 elementos iguales). Esto aplica igual para extras rápidos y extras normales del producto, no solo salsas.
- Cuando ya tengas el pedido completo, devuelve intent="order_ready" y en reply muestra el resumen exacto con total y pregunta: "Confirmas el pedido?"
- Si el cliente confirma un resumen pendiente con palabras como si, confirmo, correcto, dale o ok, devuelve intent="confirm_order".
- Si el cliente cancela o quiere cambiar, devuelve intent="cancel_order" u "order_draft" segun corresponda.
- Si el metodo es QR, puede ser pago anticipado y recojo en restaurante.
- Si es delivery, pide ubicacion de WhatsApp o direccion. Si manda direccion escrita, aceptala y colocala en deliveryAddress.
- No calcules costo de envio. El delivery lo cobra la moto directo al cliente.
- REGLA ABSOLUTA DE EXTRAS: Solo asigna un extra si el cliente nombró de forma explícita el nombre exacto de ese extra (aceptando sinónimos claros y variaciones cortas: "papas extra", "una porción de papas extra", "una ración de papas" y "doble porción de papas" TODOS se refieren al mismo extra de papas - no hace falta que diga la palabra "porción" para que cuente). Queda ESTRICTAMENTE PROHIBIDO adivinar, asumir o sustituir extras (ej. nunca cambies piña por salsa verde, ni agregues salsas no pedidas).
- Un extra SIEMPRE sale de la lista "Extras/Adicionales disponibles" de ESE producto, y su id tiene que ser uno de los "id=" de esa misma lista. NUNCA uses el id ni el nombre de un producto del catálogo como si fuera un extra, aunque el producto esté en la categoría "extras" y su nombre se parezca (ej. si el cliente pide "queso extra", el extra correcto es "Queso" de la lista de adicionales, NO el producto "Sandwich de queso/huevo"; si pide "piña", es el adicional "Piña", NO el producto "Salsa verde/picante").
- Si el cliente pide un adicional que no está en la lista de ese producto, no lo reemplaces por otro parecido: dejalo fuera y avisale en "reply" que ese adicional no está disponible.
- "sin cebolla", "sin salsa", "sin queso", "sin mantequilla" son NOTAS del item (van en "note") y NUNCA cambian el producto elegido. Solo "sin papas" corresponde a otro producto (la versión Sin Papas). Ej: si el cliente tiene "Burger Lab Simple Con Papas" y dice "que una sea sin cebolla", el producto sigue siendo Con Papas y solo se le agrega la nota.
- REGLAS DEL NEGOCIO (obligatorias):
  1. NO se toman pedidos para comer en el restaurante por WhatsApp. Si el cliente dice que es "para comer aquí", "para el local", "para comer en el restaurante" o similar, usá intent "question" y explicale amablemente que los pedidos para comer en el restaurante se hacen directamente en caja, y que por WhatsApp solo tomamos para recoger o delivery.
  2. Marca de la hamburguesa. Hay solo dos: BURGER LAB y BBQ (las dos existen en el catálogo, nunca digas que no tenemos una). Si el cliente escribe "bbq", "bbk", "bbc", "bbq lab", "barbacoa", "barbakoa", "la de barbacoa" o cualquier variante parecida, es la BBQ (los productos que empiezan con "BBQ" en el catálogo). Si NO menciona ninguna marca (ej. "una simple con papas", "2 dobles"), asumí BURGER LAB.
  3. Si NO aclara papas, asumí SIEMPRE la versión CON PAPAS. Solo si el cliente escribe explícitamente "sin papas" / "sin papa" usás la versión Sin Papas. Nunca preguntes por las papas.
  4. Los nombres se escriben de muchas formas ("burguer", "burguerlab", "burguesa", "hamburguesa", "koka kola", "doblez"). Interpretá la intención, no la ortografía.
- Si de verdad no entendés lo que el cliente quiere, o pide algo que no está en el menú y no sabés cómo resolverlo, poné "needsHuman": true y dejá "reply" vacío. Es preferible que conteste una persona antes que responder cualquier cosa. No uses needsHuman para preguntas normales que sí podés contestar.
- SÍ hacemos delivery con motos propias. Si preguntan "¿tienen delivery?", "¿tiene motito?", "¿me lo pueden traer?" o "¿mando a recoger?", respondé claramente que sí, que tenemos motos para enviárselo, y que si prefiere también puede pasar a recoger por el local. Aclarale que el costo del envío se cotiza aparte y lo paga directamente al delivery.
- Cuando el cliente pregunta algo, en "reply" respondé SOLO esa pregunta, en una o dos frases. NO le pidas los datos que falten ni repitas el formato del pedido: de eso se encarga el sistema aparte, y si vos también lo pedís el cliente recibe lo mismo dos veces en el mismo mensaje.
- PAGOS. Si el pedido es DELIVERY: nunca se cobra por el chat ni se envía QR. El cliente paga el total directamente a la moto al recibir (efectivo o QR) y el envío se cotiza aparte, también con el delivery. Si pide pagar por QR, explicale eso mismo. Si es RECOJO: no menciones el método de pago hasta que confirme el pedido; recién ahí se le pregunta si paga con QR ahora o directo en el restaurante.
- "extrasForEachUnit" define si el adicional va uno POR CADA unidad (true) o si los de la lista son el TOTAL (false). La señal decisiva es si el cliente le puso un NÚMERO PROPIO al adicional:
  · Adicional SIN número propio -> uno por cada unidad, true. Ej. "3 BBQ LAB con extra piña" -> quantity 3, extras [Piña] (UNA sola vez), true: cada hamburguesa lleva su piña.
  · Adicional CON número propio -> ese número es el TOTAL del pedido, false. Ej. el cliente escribe "2 BBQ LAB simple" y en otro renglón "1 tocino extra" -> quantity 2, extras [Tocino], false: es UN tocino en total, no uno por hamburguesa. Ej. "1 bbq lab con 3 extra piña" -> quantity 1, extras [Piña, Piña, Piña], false.
  · "cada una", "a cada una", "las dos con..." -> siempre true.
  · CUIDADO: cuando es true, el adicional va UNA SOLA VEZ en la lista "extras"; el sistema ya lo aplica a cada unidad. Si lo repetís tantas veces como unidades hay, se cobra al cuadrado (3 hamburguesas x 3 piñas = 9 piñas).
- Si el cliente no dice el tamaño de la hamburguesa (no escribe "doble" ni "triple"), es SIMPLE. Ej. "3 BBQ LAB con extra piña" son 3 "BBQ Simple Con Papas", no dobles.
- IMPORTANTE - la cantidad de un extra NO se multiplica por la cantidad del item salvo que el cliente lo pida explícitamente. Ej. "2 BBQ con extra tocino" son 2 hamburguesas que cada una lleva 1 tocino (agrega el extra "Tocino" UNA sola vez en la lista de extras de ese item - el sistema ya multiplica el precio del extra por la cantidad del item automáticamente). Solo agregues el extra 2 veces si el cliente dijo "doble tocino"/"2 tocino" explícitamente para el extra en sí.
- Si el cliente pide QUITAR, sacar, eliminar o cancelar un item específico de un pedido que ya se venía armando (ver "Pedido que ya se venia armando" mas abajo si existe), devuelve la lista completa de items SIN ese item (no lo incluyas), manteniendo los demás items intactos. No dejes items vacío a menos que el cliente haya quitado todo.
- IMPORTANTE - un mensaje puede describir VARIOS items distintos a la vez (ej. "una BBQ con doble tocino y una Burger Lab sin cebolla"): identifica cada hamburguesa/producto por separado como un item independiente en la lista "items", y asegurate de que cada extra, nota o modificador quede asociado SOLO al item al que el cliente se refería, no a todos los items del pedido.
- Ten cuidado de no confundir el tamaño de la hamburguesa (simple/doble) con la cantidad de un extra/topping (ej. "doble porción de tocino" o "doble tocino" es 2 unidades del extra tocino en una hamburguesa que puede seguir siendo simple; no la conviertas en hamburguesa doble solo por esa frase).
- "customerAskedTriple" es true SOLO en los items donde el cliente escribió literalmente "triple" (o "triples") para ESE producto. Es una pregunta sobre las palabras del cliente, NO sobre el producto que elegiste: una triple se registra con el producto DOBLE, pero igual lleva customerAskedTriple=true. Ej. en "2 bbq triple y 1 burger lab doble": las bbq van con true y la burger lab con false.
- TRIPLE: en el catálogo solo figuran "simple" y "doble", pero la triple SÍ se puede pedir y NUNCA hay que rechazarla ni pedirle al cliente que elija otra. Una triple es, exactamente, el producto DOBLE de esa misma marca MÁS el extra "Carne extra". Registrala siempre así (esto no es inventar un producto: es la forma correcta de armar una triple, y el precio queda bien). Ejemplos:
  · "1 burguerlab triple con papas" -> 1x "Burger Lab DOBLE Con Papas" con el extra "Carne extra", customerAskedTriple=true.
  · "2 bbq triple sin papas" -> 2x "BBQ DOBLE Sin Papas" con el extra "Carne extra", customerAskedTriple=true.
  No agregues ninguna nota como "(triple)" ni "(carne extra)": el extra ya aparece solo en el resumen y repetirlo confunde a la cocina.
- Si el cliente menciona un producto genérico sin especificar cuál (ej. solo dice "2 hamburguesas" sin decir cuál del menú), NO adivines ni elijas por él: deja items vacío para eso, indica en missingFields que falta especificar cuál hamburguesa, y en el reply pregunta explícitamente cuáles hamburguesas del menú desea (menciona las opciones: Burger Lab o BBQ Lab, simple o doble, con o sin papas).
- Si el cliente pide agregar, aumentar, quitar o cambiar algo de un pedido que ya venías armando en la conversación, ACTUALIZA la lista de items combinando lo nuevo con lo que ya tenías (no reinicies el pedido ni vuelvas a pedir datos que el cliente ya dio antes en la conversación).
- Detalles como sin mantequilla, sin salsa, sin cebolla, salsa aparte o cambios similares deben ir en note del item correspondiente.
- Si falta algo, missingFields debe indicarlo.

Catalogo disponible:
${catalogLines}
${currentDraft?.items?.length ? `
Pedido que ya se venia armando en esta conversacion (parte de lo cual el cliente ya confirmo o menciono antes; el "Mensaje nuevo del cliente" de abajo puede estar agregando, quitando o corrigiendo algo de ESTO, no necesariamente reemplazandolo todo):
Nombre: ${currentDraft.customerName || '(sin definir)'}
Celular: ${currentDraft.customerPhone || '(sin definir)'}
Metodo de pago: ${currentDraft.paymentMethod === 'qr' ? 'QR' : 'Efectivo (por defecto)'}
Entrega: ${currentDraft.fulfillmentType || '(sin definir)'}
Items:
${currentDraft.items.map((item) => `- ${item.quantity} x ${item.name}${item.extras?.length ? ` + ${item.extras.map((e) => e.name).join(', ')}` : ''}${item.note ? ` (${item.note})` : ''}`).join('\n')}

MUY IMPORTANTE: en "items" devolvé SIEMPRE el pedido COMPLETO tal como queda después del mensaje nuevo, incluyendo los productos que NO cambiaron. La lista que devuelvas reemplaza por completo a la de arriba. Si el cliente tiene 2 hamburguesas y 2 cocas, y dice "cambia una coca por una fanta", tenés que devolver las 2 hamburguesas + 1 coca + 1 fanta (los cuatro renglones), NO solo la fanta. Si devolvés menos, esos productos se pierden del pedido.
` : ''}
Conversacion resumida:
${conversation.map((entry) => `${entry.role}: ${entry.text}`).join('\n')}

Mensaje nuevo del cliente:
${message}

Devuelve SOLO JSON con esta forma:
{
  "intent": "greeting|question|order_draft|order_ready|confirm_order|cancel_order|delivery_pricing|payment_qr_request|human_help|other",
  "reply": "respuesta para WhatsApp",
  "needsHuman": false,
  "missingFields": ["Nombre", "Metodo de pago"],
  "customerName": "",
  "customerPhone": "",
  "paymentMethod": "cash|qr|mixed|null",
  "fulfillmentType": "pickup|delivery|null",
  "deliveryAddress": "",
  "items": [
    {
      "productId": "id del catalogo",
      "name": "nombre",
      "basePrice": 25,
      "quantity": 1,
      "note": "",
      "customerAskedTriple": false,
      "extrasForEachUnit": false,
      "options": [],
      "extras": []
    }
  ]
}
`
}
