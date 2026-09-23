/**
 * Mock de firebase-admin para tests (CommonJS).
 * Debe cargarse ANTES de require("../src/app").
 *
 * Tokens de prueba: Buffer.from(JSON.stringify({uid, role, email})).toString("base64url")
 */
const Module = require("module");
const crypto = require("crypto");

/* ───────── In-memory Firestore ───────── */

const store = new Map(); // collection -> Map<id, data>

function col(name) {
  if (!store.has(name)) store.set(name, new Map());
  return store.get(name);
}

function resetStore() {
  store.clear();
}

function seed(collection, id, data) {
  col(collection).set(id, { ...data });
}

function docsOf(collection) {
  return [...col(collection).entries()].map(([id, data]) => ({ id, data: () => ({ ...data }) }));
}

function clone(v) {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = clone(val);
    return o;
  }
  return v;
}

function makeQuery(collection, ops = {}) {
  const state = {
    collection,
    wheres: ops.wheres || [],
    // Soporta varias orderBy (Firestore exige que startAfter coincida con el nº de orderBy).
    orderBys: ops.orderBys || (ops.orderBy ? [ops.orderBy] : []),
    limit: ops.limit ?? null,
    startAfter: ops.startAfter || null,
    offset: ops.offset || 0,
  };

  function fieldValue(d, field) {
    if (field === "__name__") return d.id;
    return d.data()[field];
  }

  function exec() {
    let items = docsOf(state.collection);
    for (const w of state.wheres) {
      items = items.filter((d) => {
        const val = d.data()[w.field];
        if (w.op === "==") return val === w.value;
        if (w.op === "array-contains") return Array.isArray(val) && val.includes(w.value);
        return true;
      });
    }
    if (state.orderBys.length) {
      items.sort((a, b) => {
        for (const { field, dir } of state.orderBys) {
          const sign = dir === "desc" ? -1 : 1;
          const av = fieldValue(a, field);
          const bv = fieldValue(b, field);
          if (av == null && bv == null) continue;
          if (av == null) return 1;
          if (bv == null) return -1;
          if (av < bv) return -1 * sign;
          if (av > bv) return 1 * sign;
        }
        return 0;
      });
    }
    if (state.startAfter) {
      const { rating, id } = state.startAfter;
      const orderByField = state.orderBys[0]?.field;
      const idx = items.findIndex(
        (d) => d.id === id && Number(fieldValue(d, orderByField) ?? 0) === Number(rating ?? 0),
      );
      const byId = idx >= 0 ? idx : items.findIndex((d) => d.id === id);
      if (byId >= 0) items = items.slice(byId + 1);
    }
    if (state.limit != null) items = items.slice(0, state.limit);
    return items;
  }

  const q = {
    where(field, op, value) {
      return makeQuery(state.collection, { ...state, wheres: [...state.wheres, { field, op, value }] });
    },
    orderBy(field, dir = "asc") {
      return makeQuery(state.collection, { ...state, orderBys: [...state.orderBys, { field, dir }] });
    },
    limit(n) {
      return makeQuery(state.collection, { ...state, limit: n });
    },
    startAfter(...args) {
      // (rating, id) — debe haber exactamente tantos valores como orderBy.
      if (state.orderBys.length !== 0 && args.length !== state.orderBys.length && args.length !== 1) {
        throw new Error(
          `Too many cursor values specified. Expected ${state.orderBys.length}, got ${args.length}`,
        );
      }
      if (args.length >= 2) return makeQuery(state.collection, { ...state, startAfter: { rating: args[0], id: args[1] } });
      const snap = args[0];
      const id = snap?.id;
      const rating = snap?.data?.()?.[state.orderBys?.[0]?.field];
      return makeQuery(state.collection, { ...state, startAfter: { rating, id } });
    },
    offset(n) {
      return makeQuery(state.collection, { ...state, offset: n });
    },
    async get() {
      let items = exec();
      if (state.offset) items = items.slice(state.offset);
      return {
        empty: items.length === 0,
        size: items.length,
        docs: items,
        forEach: (fn) => items.forEach(fn),
        data: () => ({ count: items.length }), // for count().get()
      };
    },
    count() {
      return {
        async get() {
          const items = exec();
          return { data: () => ({ count: items.length }) };
        },
      };
    },
    // allow await query directly in some code paths
    then(resolve, reject) {
      return q.get().then(resolve, reject);
    },
  };
  return q;
}

function makeDocRef(collection, id) {
  return {
    id,
    collection,
    async get() {
      const data = col(collection).get(id);
      return {
        id,
        exists: data !== undefined,
        data: () => (data === undefined ? undefined : clone(data)),
      };
    },
    async set(data, opts = {}) {
      if (opts.merge) {
        const prev = col(collection).get(id) || {};
        col(collection).set(id, { ...prev, ...clone(data) });
      } else {
        col(collection).set(id, clone(data));
      }
      return this;
    },
    async update(data) {
      const prev = col(collection).get(id);
      if (prev === undefined) {
        const err = new Error("No document to update");
        err.code = 5; // NOT_FOUND
        throw err;
      }
      col(collection).set(id, { ...prev, ...clone(data) });
      return this;
    },
    async delete() {
      col(collection).delete(id);
    },
    // chainable for query-like use
    where: (f, o, v) => makeQuery(collection).where(f, o, v),
    orderBy: (f, d) => makeQuery(collection).orderBy(f, d),
    limit: (n) => makeQuery(collection).limit(n),
  };
}

function makeCollection(name) {
  return {
    doc(id) {
      return makeDocRef(name, id || crypto.randomUUID());
    },
    where(field, op, value) {
      return makeQuery(name).where(field, op, value);
    },
    orderBy(field, dir) {
      return makeQuery(name).orderBy(field, dir);
    },
    limit(n) {
      return makeQuery(name).limit(n);
    },
    async get() {
      const items = docsOf(name);
      return {
        empty: items.length === 0,
        size: items.length,
        docs: items,
        forEach: (fn) => items.forEach(fn),
      };
    },
    count() {
      return {
        async get() {
          return { data: () => ({ count: col(name).size }) };
        },
      };
    },
    async add(data) {
      const id = crypto.randomUUID();
      col(name).set(id, clone(data));
      return { id };
    },
    // forEach over collection
    async forEach(fn) {
      const items = docsOf(name);
      for (const d of items) await fn(d);
    },
  };
}

const mockDb = {
  collection: (name) => makeCollection(name),
  async runTransaction(fn) {
    const tx = {
      async get(ref) {
        return ref.get();
      },
      set(ref, data, opts) {
        return ref.set(data, opts);
      },
      update(ref, data) {
        return ref.update(data);
      },
      delete(ref) {
        return ref.delete();
      },
    };
    return fn(tx);
  },
  batch() {
    const ops = [];
    return {
      set(ref, data, opts) {
        ops.push(() => ref.set(data, opts));
        return this;
      },
      update(ref, data) {
        ops.push(() => ref.update(data));
        return this;
      },
      delete(ref) {
        ops.push(() => ref.delete());
        return this;
      },
      async commit() {
        for (const op of ops) await op();
      },
    };
  },
  FieldValue: {
    serverTimestamp: () => new Date(),
    increment: (n) => n,
  },
  // settings no-op
  settings() {},
};

/* ───────── Auth mock ───────── */

function decodeToken(token) {
  try {
    const json = Buffer.from(String(token), "base64url").toString("utf8");
    const parsed = JSON.parse(json);
    if (parsed && parsed.uid) return parsed;
  } catch { /* ignore */ }
  return null;
}

function encodeToken(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

const mockAuth = {
  async verifyIdToken(token) {
    const decoded = decodeToken(token);
    if (!decoded) {
      const err = new Error("ID token expired");
      err.code = "auth/id-token-expired";
      throw err;
    }
    return {
      uid: decoded.uid,
      email: decoded.email || `${decoded.uid}@test.local`,
      name: decoded.name,
    };
  },
  async getUser(uid) {
    return { uid, email: `${uid}@test.local` };
  },
};

/* ───────── Install mock before app loads ───────── */

function installFirebaseMock() {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "firebase-admin") {
      return {
        apps: [{ name: "[DEFAULT]" }],
        initializeApp: () => ({ name: "[DEFAULT]" }),
        credential: { cert: () => ({}) },
        firestore: () => mockDb,
        auth: () => mockAuth,
        Firestore: function Firestore() { return mockDb; },
        __isMock: true,
      };
    }
    return originalLoad.apply(this, arguments);
  };
}

installFirebaseMock();

/** Tokens de conveniencia para tests. */
const tokens = {
  admin: encodeToken({ uid: "u-admin", role: "admin", email: "admin@test.local" }),
  empresa: encodeToken({ uid: "u-emp", role: "empresa", email: "emp@test.local" }),
  cliente: encodeToken({ uid: "u-cli", role: "cliente", email: "cli@test.local" }),
  cliente2: encodeToken({ uid: "u-cli2", role: "cliente", email: "cli2@test.local" }),
  invalid: "not-a-valid-token",
};

/**
 * Seed por defecto: 1 restaurante + usuarios con tipos.
 * Llamar en beforeEach de cada suite que lo necesite.
 */
function seedBase() {
  resetStore();
  seed("usuarios", "u-admin", { uid: "u-admin", tipo: "admin", email: "admin@test.local", saldoPuntos: 100, totalAcumulado: 100, totalCanjeado: 0, nombre: "Admin" });
  seed("usuarios", "u-emp", { uid: "u-emp", tipo: "empresa", email: "emp@test.local", saldoPuntos: 50, totalAcumulado: 50, totalCanjeado: 0, nombre: "Empresa" });
  seed("usuarios", "u-cli", { uid: "u-cli", tipo: "cliente", email: "cli@test.local", saldoPuntos: 0, totalAcumulado: 0, totalCanjeado: 0, nombre: "Cliente", rachaLoginDias: 0, ultimoLoginDate: null });
  seed("usuarios", "u-cli2", { uid: "u-cli2", tipo: "cliente", email: "cli2@test.local", saldoPuntos: 0, totalAcumulado: 0, totalCanjeado: 0, nombre: "Cliente2" });
  seed("restaurants", "r1", {
    nombre: "Casa Lucio",
    rating_yelp: 4.5,
    total_resenas_yelp: 120,
    categorias: ["Española", "Mediterránea"],
    ciudad: "Madrid",
    zona_busqueda: "Madrid, Spain",
    precio: "€€",
    direccion_completa: "Calle Mayor 1",
    telefono: "910000000",
    coordenadas: { latitud: 40.4, longitud: -3.7 },
    imagen_url: "https://example.com/img.jpg",
    maxReservasPorHora: 6,
    resenas: [],
  });
  seed("restaurants", "r2", {
    nombre: "Sushi Zen",
    rating_yelp: 4.8,
    total_resenas_yelp: 80,
    categorias: ["Japonesa"],
    ciudad: "Barcelona",
    zona_busqueda: "Barcelona, Spain",
    precio: "€€€",
    direccion_completa: "Calle Mayor 2",
    resenas: [],
  });
  seed("restaurants", "r3", {
    nombre: "Pizzeria Roma",
    rating_yelp: 4.2,
    total_resenas_yelp: 50,
    categorias: ["Italiana"],
    ciudad: "Tarragona",
    zona_busqueda: "Tarragona, Spain",
    precio: "€",
    resenas: [],
  });
}

module.exports = {
  installFirebaseMock,
  resetStore,
  seed,
  seedBase,
  tokens,
  encodeToken,
  mockDb,
  store,
};
