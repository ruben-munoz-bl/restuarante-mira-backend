require("dotenv").config();

async function main() {
  const uid = process.env.PUSH_TEST_UID;
  if (!uid || uid.includes("/")) throw new Error("Indica PUSH_TEST_UID con el UID del usuario de prueba");
  const { enviarPush } = require("../src/modules/push/service");
  const resultado = await enviarPush(uid, {
    titulo: "MIRA", cuerpo: "Notificación de prueba", data: { ruta: "reservas" },
  });
  console.log(resultado);
  if (!resultado.enviados || resultado.fallidos) process.exitCode = 1;
}

main().catch(() => {
  console.error("No se pudo completar la prueba push; comprueba UID, credenciales y conectividad");
  process.exitCode = 1;
});
