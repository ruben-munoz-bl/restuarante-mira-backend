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

module.exports = { listarMensajes, contarNoLeidos, marcarLeido };
