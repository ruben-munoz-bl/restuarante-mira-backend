const { db } = require("../../middlewares/verifyFirebaseAuth");

async function listarMensajes(uid) {
  const snap = await db.collection("mensajes").where("uid", "==", uid).get();
  const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  list.sort((a, b) => (b.creado?.seconds ?? 0) - (a.creado?.seconds ?? 0));
  return list;
}

async function contarNoLeidos(uid) {
  const snap = await db.collection("mensajes").where("uid", "==", uid).get();
  let n = 0;
  snap.forEach((d) => {
    if (d.data().leido !== true) n++;
  });
  return n;
}

async function marcarLeido(id) {
  await db.collection("mensajes").doc(id).update({ leido: true });
  return { ok: true };
}

async function marcarTodosLeidos(uid) {
  const snap = await db.collection("mensajes").where("uid", "==", uid).get();
  const pendientes = snap.docs.filter((d) => d.data().leido !== true);
  for (let i = 0; i < pendientes.length; i += 450) {
    const lote = db.batch();
    for (const d of pendientes.slice(i, i + 450)) {
      lote.update(db.collection("mensajes").doc(d.id), { leido: true });
    }
    await lote.commit();
  }
  return { ok: true, actualizados: pendientes.length };
}

module.exports = { listarMensajes, contarNoLeidos, marcarLeido, marcarTodosLeidos };
