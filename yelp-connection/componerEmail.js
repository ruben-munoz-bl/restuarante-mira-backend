/**
 * componerEmail.js lógica pura del recordatorio (testeable sin enviar nada).
 * Se usa desde recordatorios.js y desde los tests.
 */

/**
 * @param {Object} reserva { nombreRestaurante, fecha, hora, comensales, codigo, direccion?, terraza? }
 * @param {Object|null} meteo { tempMax, lluviaProb, resumen }
 * @param {Array|null} parkings [{ nombre, distanciaM, lat, lng }] (mejor primero)
 * @returns {{ asunto:string, texto:string, html:string }}
 */
function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function textoDistancia(m) {
  if (m == null) return '';
  if (m < 1000) return `${m} m`;
  return `${(m / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 })} km`;
}

function linkParking(p) {
  return `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`;
}

function componerEmail(reserva, meteo, parkings = null) {
  const personas = Number(reserva.comensales) === 1 ? '1 persona' : `${reserva.comensales} personas`;
  const asunto = `Recordatorio: tu mesa mañana en ${reserva.nombreRestaurante}`;
  const listaParkings = Array.isArray(parkings) ? parkings.filter(Boolean).slice(0, 3) : [];
  const lineas = [
    `Hola,`,
    ``,
    `Te recordamos tu reserva de mañana:`,
    `  Restaurante: ${reserva.nombreRestaurante}`,
    ...(reserva.direccion ? [`  Dirección: ${reserva.direccion}`] : []),
    `  Fecha: ${reserva.fecha} a las ${reserva.hora}`,
    `  Comensales: ${personas}`,
    `  Código: ${reserva.codigo}`,
    ``,
  ];
  if (meteo && (meteo.tempMax != null || meteo.lluviaProb != null)) {
    lineas.push(`El tiempo para mañana:`);
    const partes = [];
    if (meteo.tempMax != null) partes.push(`${Math.round(meteo.tempMax)}°C de máxima`);
    if (meteo.lluviaProb != null) partes.push(`${meteo.lluviaProb}% de lluvia`);
    if (meteo.resumen) partes.push(meteo.resumen.toLowerCase());
    lineas.push(`  ${partes.join(' · ')}`);
    if (reserva.terraza === true && (meteo.tempMax >= 33 || meteo.lluviaProb >= 60)) {
      lineas.push(`  ¡Ojo! Has reservado en TERRAZA y el día viene complicado: considera pedir interior.`);
    }
    lineas.push(``);
  } else {
    lineas.push(`No pudimos obtener el pronóstico para mañana.`);
    lineas.push(``);
  }
  if (listaParkings.length > 0) {
    lineas.push(`Dónde aparcar (fuente: OpenStreetMap):`);
    for (const p of listaParkings) {
      lineas.push(`  - ${p.nombre} a ${textoDistancia(p.distanciaM)} del restaurante: ${linkParking(p)}`);
    }
    lineas.push(``);
  }
  lineas.push(`Si necesitas cambiar o cancelar, entra en Mis reservas de MIRA.`);
  lineas.push(``);
  lineas.push(`— TEAM MIRA`);
  const texto = lineas.join('\n');
  const html = `
    <div style="font-family:sans-serif;max-width:560px">
      <h2 style="color:#00664f">Recordatorio de reserva — TEAM MIRA</h2>
      <p>Hola,</p>
      <p>Te recordamos tu reserva de <strong>mañana</strong>:</p>
      <ul>
        <li><strong>Restaurante:</strong> ${escHtml(reserva.nombreRestaurante)}</li>
        ${reserva.direccion ? `<li><strong>Dirección:</strong> ${escHtml(reserva.direccion)}</li>` : ''}
        <li><strong>Fecha:</strong> ${escHtml(reserva.fecha)} a las ${escHtml(reserva.hora)}</li>
        <li><strong>Comensales:</strong> ${escHtml(personas)}</li>
        <li><strong>Código:</strong> <code>${escHtml(reserva.codigo)}</code></li>
      </ul>
      ${
        meteo && (meteo.tempMax != null || meteo.lluviaProb != null)
          ? `<h3>El tiempo para mañana</h3><p>${[
              meteo.tempMax != null ? `${Math.round(meteo.tempMax)}°C de máxima` : null,
              meteo.lluviaProb != null ? `${meteo.lluviaProb}% de lluvia` : null,
              meteo.resumen || null,
            ]
              .filter(Boolean)
              .map(escHtml)
              .join(' · ')}</p>${
              reserva.terraza === true && (meteo.tempMax >= 33 || meteo.lluviaProb >= 60)
                ? `<p><strong>¡Ojo!</strong> Has reservado en <strong>TERRAZA</strong> y el día viene complicado: considera pedir interior.</p>`
                : ''
            }`
          : `<p>No pudimos obtener el pronóstico para mañana.</p>`
      }
      ${
        listaParkings.length > 0
          ? `<h3>Dónde aparcar</h3><ul>${listaParkings
              .map(
                (p) =>
                  `<li><strong>${escHtml(p.nombre)}</strong> a ${escHtml(textoDistancia(p.distanciaM))} — <a href="${escHtml(linkParking(p))}">Cómo llegar al parking</a></li>`,
              )
              .join('')}</ul><p style="font-size:12px;color:#666">Fuente: OpenStreetMap (Overpass API).</p>`
          : ``
      }
      <p>Si necesitas cambiar o cancelar, entra en Mis reservas de MIRA.</p>
      <p>— <strong>TEAM MIRA</strong></p>
    </div>`;
  return { asunto, texto, html };
}

module.exports = { componerEmail };
