const { db } = require('./verifyFirebaseAuth');

function error(status, message) {
  return Object.assign(new Error(message), { status, code: status === 404 ? 'NOT_FOUND' : 'FORBIDDEN' });
}

async function comprobarRestaurante(id, user) {
  const snap = await db.collection('restaurants').doc(String(id || '')).get();
  if (!snap.exists) throw error(404, 'Restaurante no encontrado');
  if (user.role === 'admin') return;
  const data = snap.data();
  const perfil = await db.collection('usuarios').doc(user.uid).get();
  const p = perfil.exists ? perfil.data() : {};
  const asignados = [p.restaurantId, ...(Array.isArray(p.restaurantIds) ? p.restaurantIds : [])];
  // Restaurantes antiguos enlazados solo por email: se acepta el email del token de
  // Firebase (no se puede editar desde el perfil), nunca el email guardado en usuarios.
  const emailToken = String(user.email || '').trim().toLowerCase();
  const porEmail = Boolean(emailToken) && String(data.email || '').trim().toLowerCase() === emailToken;
  if (data.uid !== user.uid && data.ownerUid !== user.uid && !asignados.includes(id) && !porEmail) {
    throw error(403, 'No tienes permiso sobre este restaurante');
  }
}

function restaurantePropio(param = 'id') {
  return async (req, _res, next) => {
    try { await comprobarRestaurante(req.params[param], req.user); next(); } catch (err) { next(err); }
  };
}

function documentoDelRestaurante(coleccion, param = 'id') {
  return async (req, _res, next) => {
    try {
      const snap = await db.collection(coleccion).doc(req.params[param]).get();
      if (!snap.exists) throw error(404, 'Documento no encontrado');
      const d = snap.data();
      await comprobarRestaurante(d.restaurantId || d.restauranteId, req.user);
      next();
    } catch (err) { next(err); }
  };
}

async function protegerComision(req, _res, next) {
  try {
    if (req.user.role !== 'admin' && req.body?.comisionPct !== undefined) {
      const actual = await db.collection('restaurants').doc(req.params.id).get();
      if (req.body.comisionPct !== actual.data()?.comisionPct) {
        throw error(403, 'Solo un administrador puede cambiar la comisión');
      }
      // El formulario existente envía el documento entero, aunque solo se
      // cambie el nombre. No reenviar una comisión que no se ha modificado.
      delete req.body.comisionPct;
    }
    next();
  } catch (err) { next(err); }
}

module.exports = { comprobarRestaurante, restaurantePropio, documentoDelRestaurante, protegerComision };
