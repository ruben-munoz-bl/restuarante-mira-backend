const crypto = require("crypto");
const { db } = require("../../middlewares/verifyFirebaseAuth");

const COLLECTION = "aiConfirms";
const TTL_MS = 10 * 60 * 1000;

async function createConfirm({ uid, role, tool, args, summary }) {
  const confirmId = crypto.randomUUID();
  await db.collection(COLLECTION).doc(confirmId).set({
    uid: uid || null,
    role: role || null,
    tool,
    args,
    summary,
    createdAt: new Date(),
    expiresAt: Date.now() + TTL_MS,
  });
  return confirmId;
}

async function takeConfirm(confirmId, user) {
  if (!confirmId || !user) return null;
  const ref = db.collection(COLLECTION).doc(confirmId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data();
  if (!data || data.uid !== user.uid) return null;
  const expiresAt = typeof data.expiresAt === "number" ? data.expiresAt : Date.parse(data.expiresAt);
  if (!expiresAt || expiresAt < Date.now()) {
    await ref.delete();
    return null;
  }
  await ref.delete();
  return data;
}

module.exports = { createConfirm, takeConfirm, COLLECTION, TTL_MS };
