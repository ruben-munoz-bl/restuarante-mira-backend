const PATTERNS = [
  /\b[0-5][.,]\d\s*(?:★|⭐|estrellas?|\/\s*5)/i,
  /\b\d{1,3}(?:[.,]\d{1,2})?\s*(?:€|euros?)\b/i,
  /(?:libre|disponible|ocupad[oa]|completo|no hay sitio)[^.\n]{0,40}?(?:1[2-4]|2[0-2])[.:][03]0/i,
  /(?:1[2-4]|2[0-2])[.:][03]0[^.\n]{0,40}?(?:libre|disponible|ocupad[oa]|completo|hay sitio)/i,
];

function detect(reply, actions) {
  if (!reply) return false;
  if (actions && actions.length) return false;
  return PATTERNS.some((re) => re.test(reply));
}

const RETRY_NOTE =
  "[SISTEMA] Tu respuesta anterior contenía datos que no provienen de ninguna tool. " +
  "Vuelve a responder SOLO con datos obtenidos de las tools de esta conversación; " +
  "si no tienes datos, di honestamente que necesitas consultar la API y lanza la tool adecuada.";

function fallbackReply() {
  return "Puedo comprobarlo en la API si me dices qué consultar (restaurante, fecha y hora); con eso lo confirmo.";
}

module.exports = { detect, RETRY_NOTE, fallbackReply, PATTERNS };
